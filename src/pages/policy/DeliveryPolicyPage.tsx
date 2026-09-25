import { PolicyLayout } from '../../components/shared/PolicyLayout';

export function DeliveryPolicyPage() {
  return (
    <PolicyLayout title="ডেলিভারি তথ্য">
      <p>
        আমরা সারা বাংলাদেশে Steadfast Courier-এর মাধ্যমে ডেলিভারি দিই। প্রয়োজনে আরও কুরিয়ার
        যোগ হবে।
      </p>

      <div className="policy-page__table-wrap">
        <table className="policy-page__table">
          <thead>
            <tr>
              <th>এলাকা</th>
              <th>ডেলিভারি চার্জ</th>
              <th>সময়</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>ঢাকা সিটি</td>
              <td>৳70</td>
              <td>১-২ দিন</td>
            </tr>
            <tr>
              <td>ঢাকার বাইরে</td>
              <td>৳130</td>
              <td>২-৫ দিন</td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul>
        <li>
          পার্সেলের ওজন বেশি হলে ডেলিভারি চার্জ বাড়তে পারে। সেক্ষেত্রে অর্ডার confirm করার সময়
          আপনাকে জানানো হবে।
        </li>
        <li>
          অর্ডার confirm হওয়ার পর থেকে সময় গণনা শুরু হয়। সরকারি ছুটি, খারাপ আবহাওয়া বা
          কুরিয়ারের সমস্যায় কিছুটা দেরি হতে পারে।
        </li>
        <li>পাঠানোর পর আপনার "আমার অর্ডার" পেজে ট্র্যাকিং নম্বর দেখাবে।</li>
        <li>পেমেন্ট: Cash on Delivery (পণ্য হাতে পেয়ে টাকা), অথবা bKash-এ আগাম।</li>
      </ul>

      <h2>ডেলিভারি ব্যর্থ হলে</h2>
      <ul>
        <li>
          কুরিয়ার আপনাকে ফোন করে পাওয়া না গেলে আমরা ২ বার যোগাযোগের চেষ্টা করব। তারপরও না পেলে
          অর্ডার বাতিল হবে।
        </li>
        <li>
          কোনো কারণ ছাড়া পণ্য নিতে অস্বীকার করলে ডেলিভারি আর ফেরতের খরচ আপনাকে দিতে হবে। bKash-এ
          আগাম দিয়ে থাকলে সেই খরচ কেটে বাকি টাকা ফেরত দেওয়া হবে।
        </li>
      </ul>
    </PolicyLayout>
  );
}
