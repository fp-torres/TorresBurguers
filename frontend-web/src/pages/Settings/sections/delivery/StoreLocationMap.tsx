import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Mapa do local da loja (Leaflet + "tiles" do OpenStreetMap). Carregado sob demanda (React.lazy) só no modo de
 * entrega por distância. CSP: só as imagens de https://tile.openstreetmap.org (vite.config.ts); o Leaflet vem
 * do próprio bundle. O pino é arrastável (mouse, toque ou teclado) e um clique no mapa também o move.
 */
interface StoreLocationMapProps {
  latitude: number | null;
  longitude: number | null;
  readOnly: boolean;
  onChange: (latitude: number, longitude: number) => void;
}

/** Centro do Brasil quando a loja ainda não tem local. */
const BRAZIL_CENTER: L.LatLngTuple = [-15.78, -47.93];

const PIN_ICON = L.divIcon({
  className: '',
  // Pino em SVG (sem imagem externa nem arquivo do pacote): cor da marca do painel
  html:
    '<svg width="32" height="42" viewBox="0 0 32 42" aria-hidden="true"><path d="M16 0C7.2 0 0 7 0 15.7 0 27.5 16 42 16 42s16-14.5 16-26.3C32 7 24.8 0 16 0z" fill="#ea580c" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15.5" r="6" fill="#fff"/></svg>',
  iconSize: [32, 42],
  iconAnchor: [16, 42],
});

export default function StoreLocationMap({ latitude, longitude, readOnly, onChange }: StoreLocationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);

  useEffect(() => {
    onChangeRef.current = onChange;
    readOnlyRef.current = readOnly;
  }, [onChange, readOnly]);

  // O mapa é criado uma vez; o pino acompanha as coordenadas no efeito abaixo
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const map = L.map(containerRef.current, {
      center: BRAZIL_CENTER,
      zoom: 4,
      // Rolar a página não dá zoom sem querer (use os botões + e − ou dois dedos)
      scrollWheelZoom: false,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) => {
      if (!readOnlyRef.current) onChangeRef.current(event.latlng.lat, event.latlng.lng);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (latitude === null || longitude === null) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const point: L.LatLngTuple = [latitude, longitude];
    if (markerRef.current) {
      markerRef.current.setLatLng(point);
    } else {
      const marker = L.marker(point, {
        icon: PIN_ICON,
        draggable: !readOnly,
        keyboard: true,
        title: 'Local da loja: arraste o pino para ajustar',
        alt: 'Local da loja',
      }).addTo(map);
      marker.on('dragend', () => {
        const position = marker.getLatLng();
        onChangeRef.current(position.lat, position.lng);
      });
      markerRef.current = marker;
      map.setView(point, 16);
      return;
    }
    if (!map.getBounds().pad(-0.1).contains(point)) map.setView(point, Math.max(map.getZoom(), 15));
  }, [latitude, longitude, readOnly]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker?.dragging) return;
    if (readOnly) marker.dragging.disable();
    else marker.dragging.enable();
  }, [readOnly]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Mapa com o local da loja. Arraste o pino ou clique no mapa para ajustar."
      className="h-64 sm:h-72 w-full rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden z-0"
      data-testid="store-location-map"
    />
  );
}
