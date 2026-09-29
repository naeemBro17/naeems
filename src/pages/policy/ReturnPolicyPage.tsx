import { PolicyLayout } from '../../components/shared/PolicyLayout';

export function ReturnPolicyPage() {
  return (
    <PolicyLayout title="Return & refund policy">
      <p>
        We import our products ourselves and sell only genuine products. Even so, if something goes
        wrong, we take responsibility depending on the situation.
      </p>

      <h2>When we will refund or replace</h2>
      <ul>
        <li>If we sent the wrong product or the wrong size</li>
        <li>If the product arrives broken, leaking or damaged</li>
        <li>If you receive an expired product</li>
      </ul>
      <p>
        In these cases, let us know within 24 hours of receiving the product, with a photo or video.
        We will pay the delivery cost of the return.
      </p>

      <h2>When we can't take a return</h2>
      <p>
        Opened or used skincare products can't be returned. Products can't be returned because they
        didn't suit your skin or because you changed your mind.
      </p>

      <h2>What to do when your parcel arrives</h2>
      <p>
        Record a short video while opening the package. If there is a problem, it helps us sort it
        out quickly.
      </p>
    </PolicyLayout>
  );
}
