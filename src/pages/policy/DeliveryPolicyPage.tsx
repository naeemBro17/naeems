import { PolicyLayout } from '../../components/shared/PolicyLayout';

export function DeliveryPolicyPage() {
  return (
    <PolicyLayout title="Delivery">
      <p>
        We deliver all over Bangladesh through Steadfast Courier. More couriers will be added if
        needed.
      </p>

      <div className="policy-page__table-wrap">
        <table className="policy-page__table">
          <thead>
            <tr>
              <th>Area</th>
              <th>Delivery charge</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Dhaka city</td>
              <td>৳70</td>
              <td>1-2 days</td>
            </tr>
            <tr>
              <td>Outside Dhaka</td>
              <td>৳130</td>
              <td>2-5 days</td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul>
        <li>
          A heavy parcel may cost more to deliver. If so, we will tell you when we confirm your order.
        </li>
        <li>
          Delivery time is counted from when your order is confirmed. Public holidays, bad weather or
          courier problems can cause some delay.
        </li>
        <li>Once your parcel is sent, its tracking number appears on your "My Orders" page.</li>
        <li>Payment: Cash on Delivery (pay when you receive it), or pay in advance with bKash.</li>
      </ul>

      <h2>If delivery fails</h2>
      <ul>
        <li>
          If the courier can't reach you by phone, we will try to contact you twice. If we still can't
          reach you, the order will be cancelled.
        </li>
        <li>
          If you refuse the parcel without a valid reason, you will have to pay the delivery and return
          cost. If you paid in advance with bKash, we will deduct that cost and refund the rest.
        </li>
      </ul>
    </PolicyLayout>
  );
}
