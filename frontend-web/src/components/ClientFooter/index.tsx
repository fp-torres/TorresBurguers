import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Facebook, Instagram, Twitter, MapPin, Phone, Mail, Clock } from 'lucide-react';
import BrandLogo from '../BrandLogo';
import { BRAND, STORE_INFO } from '../../config/brand';

export default function ClientFooter() {
  const currentYear = new Date().getFullYear();

  return (
    // Fundo branco no Light, Slate-950 no Dark
    <footer className="bg-white dark:bg-slate-950 pt-16 pb-8 border-t-4 border-orange-600 transition-colors">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 mb-12">

          <div className="space-y-6">
            <BrandLogo size={44} />
            <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              O autêntico sabor artesanal. Ingredientes selecionados, carne suculenta e receitas exclusivas.
            </p>
            <div className="flex gap-4">
              <SocialLink label="Instagram" icon={<Instagram size={20} />} />
              <SocialLink label="Facebook" icon={<Facebook size={20} />} />
              <SocialLink label="Twitter" icon={<Twitter size={20} />} />
            </div>
          </div>

          <div>
            <h4 className="text-gray-900 dark:text-white font-bold mb-6 text-lg">Navegação</h4>
            <ul className="space-y-3 text-sm text-gray-600 dark:text-gray-400">
              <FooterLink to="/" label="Cardápio Completo" />
              <FooterLink to="/cart" label="Meu Carrinho" />
              <FooterLink to="/my-orders" label="Acompanhar Pedidos" />
              <FooterLink to="/signin" label="Login / Cadastro" />
            </ul>
          </div>

          {/* CONTATO + HORÁRIO */}
          <div>
            <h4 className="text-gray-900 dark:text-white font-bold mb-6 text-lg">Atendimento</h4>
            <ul className="space-y-4 text-sm text-gray-600 dark:text-gray-400">
              <li className="flex items-start gap-3 group">
                <MapPin size={20} className="text-orange-600 shrink-0 mt-0.5" />
                <span>{STORE_INFO.addressLine}<br />{STORE_INFO.cityLine}</span>
              </li>
              <li className="flex items-start gap-3 group">
                <Clock size={20} className="text-orange-600 shrink-0 mt-0.5" />
                <div>
                  <span className="block font-bold text-gray-900 dark:text-white">{STORE_INFO.openingDays}</span>
                  <span>{STORE_INFO.openingHours}</span>
                </div>
              </li>
              <li className="flex items-center gap-3 group">
                <Phone size={20} className="text-orange-600 shrink-0" />
                <span>{STORE_INFO.phone}</span>
              </li>
            </ul>
          </div>

          {/* FALE CONOSCO (e-mail de suporte da configuração da marca) */}
          <div>
            <h4 className="text-gray-900 dark:text-white font-bold mb-6 text-lg">Fale Conosco</h4>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Dúvidas sobre um pedido, sugestões ou problemas com a sua conta? Escreva para a gente.
            </p>
            <a
              href={`mailto:${BRAND.supportEmail}`}
              className="inline-flex items-center gap-2 bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-gray-100 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-slate-800 text-sm font-medium hover:border-orange-500 hover:text-orange-600 dark:hover:text-orange-400 transition-colors break-all"
            >
              <Mail size={18} className="text-orange-600 shrink-0" /> {BRAND.supportEmail}
            </a>
          </div>
        </div>

        <div className="border-t border-gray-100 dark:border-slate-800 pt-8 flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-gray-500 dark:text-gray-500">
          <p>&copy; {currentYear} {BRAND.name}. Todos os direitos reservados.</p>
          <div className="flex gap-6">
             <Link to="/login" className="hover:text-orange-600 transition-colors">Área do Funcionário</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ to, label }: { to: string, label: string }) {
  return <li><Link to={to} className="hover:text-orange-600 transition-colors flex items-center gap-2"><span className="w-1 h-1 bg-orange-600 rounded-full"></span>{label}</Link></li>;
}

function SocialLink({ icon, label }: { icon: ReactNode, label: string }) {
  return <a href="#" aria-label={label} title={label} onClick={(e) => e.preventDefault()} className="bg-gray-100 dark:bg-slate-900 p-2.5 rounded-lg hover:bg-orange-600 hover:text-white text-gray-500 dark:text-gray-400 transition-all border border-transparent dark:border-slate-800">{icon}</a>;
}
