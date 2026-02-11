import { Link } from 'react-router-dom';
import { Facebook, Instagram, Twitter, MapPin, Phone, Mail, ArrowRight, ShieldCheck, Clock } from 'lucide-react';

export default function ClientFooter() {
  return (
    <footer className="bg-gray-900 text-gray-400 pt-16 pb-8 border-t-4 border-orange-600">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 mb-12">
          
          <div className="space-y-6">
            <h3 className="text-2xl font-bold text-white tracking-tighter flex items-center gap-2">
              Torres<span className="text-orange-500">Burgers</span>
            </h3>
            <p className="text-sm leading-relaxed text-gray-400">
              O autêntico sabor artesanal. Ingredientes selecionados, carne suculenta e receitas exclusivas.
            </p>
            <div className="flex gap-4">
              <SocialLink icon={<Instagram size={20} />} />
              <SocialLink icon={<Facebook size={20} />} />
              <SocialLink icon={<Twitter size={20} />} />
            </div>
          </div>

          <div>
            <h4 className="text-white font-bold mb-6 text-lg">Navegação</h4>
            <ul className="space-y-3 text-sm">
              <FooterLink to="/" label="Cardápio Completo" />
              <FooterLink to="/cart" label="Meu Carrinho" />
              <FooterLink to="/my-orders" label="Acompanhar Pedidos" />
              <FooterLink to="/signin" label="Login / Cadastro" />
            </ul>
          </div>

          {/* CONTATO + HORÁRIO */}
          <div>
            <h4 className="text-white font-bold mb-6 text-lg">Atendimento</h4>
            <ul className="space-y-4 text-sm">
              <li className="flex items-start gap-3 group">
                <MapPin size={20} className="text-orange-500 shrink-0 mt-0.5" />
                <span>Rua das Flores, 123 - Centro<br />Rio de Janeiro - RJ</span>
              </li>
              {/* HORÁRIO ADICIONADO AQUI */}
              <li className="flex items-start gap-3 group">
                <Clock size={20} className="text-orange-500 shrink-0 mt-0.5" />
                <div>
                  <span className="block font-bold text-white">Terça a Domingo</span>
                  <span>12:00 às 04:00 (Madrugada)</span>
                </div>
              </li>
              <li className="flex items-center gap-3 group">
                <Phone size={20} className="text-orange-500 shrink-0" />
                <span>(21) 99999-9999</span>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-white font-bold mb-6 text-lg">Ganhe Descontos</h4>
            <p className="text-sm text-gray-400 mb-4">
              Receba ofertas exclusivas e cupons secretos.
            </p>
            <div className="flex gap-2">
               <input type="email" placeholder="Seu e-mail" className="bg-gray-800 text-white px-4 py-2 rounded-lg w-full outline-none border border-gray-700 text-sm" />
               <button className="bg-orange-600 hover:bg-orange-700 text-white p-2 rounded-lg"><ArrowRight size={20} /></button>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-800 pt-8 flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-gray-500">
          <p>&copy; 2026 TorresBurgers. Todos os direitos reservados.</p>
          <div className="flex gap-6">
             <Link to="/login" className="hover:text-orange-500">Área do Funcionário</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ to, label }: { to: string, label: string }) {
  return <li><Link to={to} className="hover:text-orange-500 transition-colors flex items-center gap-2"><span className="w-1 h-1 bg-orange-500 rounded-full"></span>{label}</Link></li>;
}

function SocialLink({ icon }: { icon: any }) {
  return <a href="#" className="bg-gray-800 p-2.5 rounded-lg hover:bg-orange-600 hover:text-white text-gray-400 transition-all">{icon}</a>;
}