import { PolicyLayout } from '../../components/shared/PolicyLayout';

const WHATSAPP_LINK = 'https://wa.me/8801560040012';
const EMAIL = 'naeemonlinemail@gmail.com';

export function PrivacyPolicyPage() {
  return (
    <PolicyLayout title="Privacy policy">
      <p>
        We use your information only to deliver your orders and to serve you. We never sell it to
        anyone.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li>From Google login: your name, email and profile photo</li>
        <li>What you give us: your phone number and delivery address</li>
        <li>Order details: what you bought, how much, and how you paid (including the bKash Transaction ID)</li>
        <li>Site usage: which pages you viewed and which products you added to your cart</li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>To process and deliver your orders</li>
        <li>To contact you about your orders</li>
        <li>To fill in your address for your next order</li>
      </ul>

      <h2>Who we share it with</h2>
      <ul>
        <li>Steadfast Courier: only your name, phone, address and the COD amount, for delivery</li>
        <li>Facebook and Google: site usage information (through cookies), for advertising</li>
        <li>The relevant authorities, if the law requires it</li>
        <li>No one else</li>
      </ul>

      <h2>Keeping your information safe</h2>
      <p>
        Your information is stored on secure servers. You can see only your own information and
        orders, never another customer's.
      </p>

      <h2>Your rights</h2>
      <ul>
        <li>You can change your phone number and address at any time from the Account page.</li>
        <li>
          To delete your account and information, tell us on WhatsApp or by email and we will delete
          it within 7 days. Records of completed orders may be kept for accounting.
        </li>
      </ul>

      <p>
        <strong>Contact:</strong>{' '}
        <a href={WHATSAPP_LINK} target="_blank" rel="noopener noreferrer">
          WhatsApp 01560040012
        </a>{' '}
        · <a href={`mailto:${EMAIL}`}>Email {EMAIL}</a>
      </p>

      <p>If this policy changes, we will announce it on this page with the date.</p>
    </PolicyLayout>
  );
}
