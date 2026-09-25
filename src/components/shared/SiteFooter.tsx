import { Link } from 'react-router-dom';

/** Policy/trust links shown at the bottom of the home page and account page
 *  (Batch 19 Part 4) — the only place these five pages are always reachable
 *  from besides the hamburger menu. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link to="/about">আমাদের সম্পর্কে</Link>
      <Link to="/delivery">ডেলিভারি তথ্য</Link>
      <Link to="/return-policy">রিটার্ন পলিসি</Link>
      <Link to="/terms">শর্তাবলি</Link>
      <Link to="/privacy">প্রাইভেসি পলিসি</Link>
    </footer>
  );
}
