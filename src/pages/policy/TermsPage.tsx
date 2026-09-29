import { PolicyLayout } from '../../components/shared/PolicyLayout';

export function TermsPage() {
  return (
    <PolicyLayout title="Cancellation & terms">
      <p>You can cancel an order until it is handed to the courier.</p>

      <h2>Cancelling an order</h2>
      <ul>
        <li>While your order is "Pending", you can cancel it yourself from your "My Orders" page.</li>
        <li>After it is confirmed but before it is sent, message us on WhatsApp to cancel.</li>
        <li>Once it has been handed to the courier, it can no longer be cancelled.</li>
        <li>
          If an order paid in advance with bKash is cancelled before it is sent, the full amount will
          be refunded within 3 working days.
        </li>
      </ul>

      <h2>General terms</h2>
      <ul>
        <li>Prices and stock on the site can change. The price at the time you order is the price you pay.</li>
        <li>
          If a price or stock detail was wrong, we may cancel the order after letting you know. If you
          paid in advance, the full amount will be refunded.
        </li>
        <li>
          Product descriptions are general information. Do a patch test before using a new product.
          For serious skin problems, see a doctor.
        </li>
        <li>
          If the courier causes a delay, we will do our best to sort it out quickly, but we can't
          offer compensation for it.
        </li>
      </ul>
    </PolicyLayout>
  );
}
