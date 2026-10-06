import { Link } from 'react-router-dom';
import { PolicyLayout } from '../../components/shared/PolicyLayout';

export function AboutPage() {
  return (
    <PolicyLayout title="About us">
      <p>
        NAEEM'S is a trusted place for original skincare, brought directly from Australia, Canada,
        Japan, the USA, the UK and India.
      </p>
      <p>
        Fake skincare is now a big problem in Bangladesh, and the wrong product can harm your skin.
        That is why, since 2024, we have been bringing products from trusted sources in these
        countries and delivering them straight to you.
      </p>

      <h2>Why you can trust us</h2>
      <ul>
        <li>Every product is bought from well-known stores abroad (such as Amazon, Boots and Target)</li>
        <li>Expiry dates are checked before import, and expired products are never sold</li>
        <li>Free advice on choosing products for your skin type (for now)</li>
        <li>Trusted by 500+ clients and 2,000+ customers at home and abroad</li>
      </ul>

      <h2>A word from the founder</h2>
      <p>
        I'm Naeem, a non-medical skincare consultant. After struggling with my own skin problems and
        with fake products, I realised how hard it is to find original skincare in this country. So
        in 2024 I started NAEEM'S.
      </p>
      <p>
        I check what I sell before I sell it. I don't recommend products that don't work or that are
        just marketing gimmicks, and any advice I give is based on understanding your problem.
      </p>
      <p>
        But skin results don't depend on the product alone. They also depend on your diet, sleep,
        stress, how regularly you use the product, and how your skin responds to it.
      </p>
      <p>
        Even when everything is right, results can take time, because they are not the same for
        everyone. So please be patient.
      </p>
      <p>
        I am not a doctor, and I am not a replacement for one. For serious skin problems, please see
        a dermatologist.
      </p>
      <p>
        Not sure which product is right for you? Talk to me directly through{' '}
        <Link to="/contact">"Talk with Naeem"</Link>.
      </p>
    </PolicyLayout>
  );
}
