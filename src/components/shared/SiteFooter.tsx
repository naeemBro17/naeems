import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

/** Policy/trust links shown at the bottom of Home, Shop and the account
 *  page (Batch 19 Part 4). Batch 71: the hamburger menu is gone, so this
 *  (and the Account page list) is where these pages live; the Wholesale
 *  account link only for an approved wholesaler (the real role from the
 *  session, as the menu did). */
export function SiteFooter() {
  const { profile } = useAuth();
  const isApprovedWholesaler = profile?.role === 'wholesaler' && profile?.status === 'approved';
  return (
    <footer className="site-footer">
      <Link to="/about">About us</Link>
      <Link to="/delivery">Delivery info</Link>
      <Link to="/return-policy">Return policy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/privacy">Privacy policy</Link>
      {isApprovedWholesaler && <Link to="/wholesaler-access">Wholesale account</Link>}
    </footer>
  );
}
