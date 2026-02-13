import Cards from 'react-credit-cards-2';
import 'react-credit-cards-2/dist/es/styles-compiled.css';

interface CreditCardProps {
  number: string;
  name: string;
  expiry: string;
  cvc: string;
  focus: 'number' | 'name' | 'expiry' | 'cvc' | '';
  issuer?: string; // <--- Aceita a bandeira forçada (ex: mastercard)
}

export default function CreditCard({ number, name, expiry, cvc, focus, issuer }: CreditCardProps) {
  return (
    <div className="flex justify-center mb-6 transform scale-90 sm:scale-100">
      <Cards
        number={number}
        name={name}
        expiry={expiry}
        cvc={cvc}
        focused={focus}
        issuer={issuer} // <--- Repassa para o componente visual
        placeholders={{ name: 'SEU NOME AQUI' }}
        locale={{ valid: 'VALIDADE' }}
      />
    </div>
  );
}