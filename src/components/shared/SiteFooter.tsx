import { Link } from 'react-router-dom';

/** Policy/trust links shown at the bottom of the home page and account page
 *  (Batch 19 Part 4) — the only place these five pages are always reachable
 *  from besides the hamburger menu. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link to="/about">About us</Link>
      <Link to="/delivery">Delivery</Link>
      <Link to="/return-policy">Return policy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/privacy">Privacy policy</Link>
    </footer>
  );
}
