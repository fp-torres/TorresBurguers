import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Mail, MapPin, Navigation, Phone, Store as StoreIcon } from 'lucide-react';
import BrandLogo, { BrandMark } from '../BrandLogo';
import StoreLogo from '../BrandLogo/StoreLogo';
import { BRAND } from '../../config/brand';
import type { PublicStoreProfile } from '../../services/publicStoreService';
import {
  formatStorePhone, groupOpeningHours, phoneHref, storeAddressLines, storeMapUrl, weekdayInTimeZone,
} from '../../services/storefrontDisplay';
import { storePath } from '../../utils/lastStore';

interface ClientFooterProps {
  /** Loja da vitrine: rodapé com endereço, contato e horários dela. Sem loja: rodapé da plataforma. */
  store?: PublicStoreProfile | null;
}

/** Rodapé da vitrine (identidade da LOJA) ou das páginas da conta (identidade da plataforma). */
export default function ClientFooter({ store }: ClientFooterProps) {
  return store ? <StoreFooter store={store} /> : <PlatformFooter />;
}

function StoreFooter({ store }: { store: PublicStoreProfile }) {
  const currentYear = new Date().getFullYear();
  const address = storeAddressLines(store.address);
  const mapUrl = storeMapUrl(store.address);
  const phone = formatStorePhone(store.phone);
  const tel = phoneHref(store.phone);
  const hours = groupOpeningHours(store.opening_hours);
  const today = weekdayInTimeZone(store.time_zone);
  const hasContact = !!address || !!phone || !!store.email;

  return (
    <footer className="bg-white dark:bg-slate-950 pt-12 pb-8 border-t-4 border-brand transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10 mb-10">

          <div className="space-y-4">
            <Link to={storePath(store.slug)} className="inline-flex items-center gap-3 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              <StoreLogo name={store.name} logo={store.logo} size={44} decorative />
              <span className="text-xl font-extrabold text-gray-900 dark:text-white wrap-break-word">{store.name}</span>
            </Link>
            {store.description && (
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{store.description}</p>
            )}
          </div>

          <nav aria-labelledby="footer-nav-title">
            <h2 id="footer-nav-title" className="text-gray-900 dark:text-white font-bold mb-4 text-lg">Navegação</h2>
            <ul className="space-y-3 text-sm text-gray-600 dark:text-gray-400">
              <FooterLink to={storePath(store.slug)} label="Cardápio" />
              <FooterLink to={storePath(store.slug, 'cart')} label="Meu carrinho" />
              <FooterLink to="/my-orders" label="Acompanhar pedidos" />
              <FooterLink to="/" label="Outros estabelecimentos" />
            </ul>
          </nav>

          <div>
            <h2 className="text-gray-900 dark:text-white font-bold mb-4 text-lg">Atendimento</h2>
            {hasContact ? (
              <ul className="space-y-4 text-sm text-gray-600 dark:text-gray-400">
                {address && (
                  <li className="flex items-start gap-3">
                    <MapPin size={20} className="text-brand-ink dark:text-brand-ink-dark shrink-0 mt-0.5" aria-hidden="true" />
                    <div>
                      <span className="sr-only">Endereço: </span>
                      {address.street && <span className="block">{address.street}</span>}
                      {address.area && <span className="block">{address.area}</span>}
                      {address.zip && <span className="block">{address.zip}</span>}
                      {mapUrl && (
                        <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-1 text-xs font-bold text-brand-ink dark:text-brand-ink-dark hover:underline">
                          <Navigation size={12} aria-hidden="true" /> Ver no mapa<span className="sr-only"> (abre em nova aba)</span>
                        </a>
                      )}
                    </div>
                  </li>
                )}
                {phone && (
                  <li className="flex items-center gap-3">
                    <Phone size={20} className="text-brand-ink dark:text-brand-ink-dark shrink-0" aria-hidden="true" />
                    {tel ? (
                      <a href={tel} className="hover:underline"><span className="sr-only">Telefone: </span>{phone}</a>
                    ) : (
                      <span><span className="sr-only">Telefone: </span>{phone}</span>
                    )}
                  </li>
                )}
                {store.email && (
                  <li className="flex items-center gap-3 min-w-0">
                    <Mail size={20} className="text-brand-ink dark:text-brand-ink-dark shrink-0" aria-hidden="true" />
                    <a href={`mailto:${store.email}`} className="hover:underline break-all"><span className="sr-only">E-mail: </span>{store.email}</a>
                  </li>
                )}
              </ul>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">A loja ainda não informou endereço e contato.</p>
            )}
          </div>

          <div>
            <h2 className="text-gray-900 dark:text-white font-bold mb-4 text-lg flex items-center gap-2">
              <Clock size={18} className="text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" /> Horários
            </h2>
            {hours.length > 0 ? (
              <dl className="space-y-2 text-sm">
                {hours.map((line) => {
                  const isToday = line.dayIndexes.includes(today);
                  return (
                    <div key={line.days} className={`flex flex-wrap justify-between gap-x-3 gap-y-0.5 ${isToday ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}>
                      <dt>
                        {line.days}
                        {isToday && <span className="ml-1.5 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand/10 text-brand-ink dark:text-brand-ink-dark">Hoje</span>}
                      </dt>
                      <dd className={line.closed ? 'text-gray-400 dark:text-gray-500' : undefined}>{line.hours}</dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">Horários não informados. O selo do topo mostra se a loja está aberta agora.</p>
            )}
          </div>
        </div>

        <div className="border-t border-gray-100 dark:border-slate-800 pt-6 flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
          <p>&copy; {currentYear} {store.name}</p>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link to="/" className="inline-flex items-center gap-1.5 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
              Pedidos online por
              <span className="inline-flex items-center gap-1 font-bold text-gray-700 dark:text-gray-200">
                <BrandMark size={14} /> {BRAND.name}
              </span>
            </Link>
            <Link to="/login" className="hover:text-gray-800 dark:hover:text-gray-200 transition-colors">Área do lojista</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function PlatformFooter() {
  const currentYear = new Date().getFullYear();
  return (
    <footer className="bg-white dark:bg-slate-950 border-t border-gray-100 dark:border-slate-800 transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 text-sm text-gray-500 dark:text-gray-400">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <BrandLogo size={28} />
          <nav aria-label="Links da plataforma" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <Link to="/" className="inline-flex items-center gap-1.5 hover:text-orange-700 dark:hover:text-orange-400 transition-colors">
              <StoreIcon size={14} aria-hidden="true" /> Estabelecimentos
            </Link>
            <Link to="/cadastrar-loja" className="font-bold text-orange-700 dark:text-orange-400 hover:underline">Cadastre seu estabelecimento</Link>
            <Link to="/login" className="hover:text-orange-700 dark:hover:text-orange-400 transition-colors">Área do lojista</Link>
            <a href={`mailto:${BRAND.supportEmail}`} className="inline-flex items-center gap-1.5 hover:text-orange-700 dark:hover:text-orange-400 transition-colors break-all">
              <Mail size={14} aria-hidden="true" className="shrink-0" />{BRAND.supportEmail}
            </a>
          </nav>
        </div>
        <p className="text-center md:text-left text-xs border-t border-gray-100 dark:border-slate-800 pt-4">
          &copy; {currentYear} {BRAND.name}. Todos os direitos reservados.
        </p>
      </div>
    </footer>
  );
}

function FooterLink({ to, label }: { to: string; label: ReactNode }) {
  return (
    <li>
      <Link to={to} className="hover:text-brand-ink dark:hover:text-brand-ink-dark transition-colors flex items-center gap-2">
        <span className="w-1 h-1 bg-brand rounded-full" aria-hidden="true" />{label}
      </Link>
    </li>
  );
}
