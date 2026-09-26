import { test, expect } from './fixtures';
import { signInAsTestCustomer } from './helpers/auth';

// Logged-in, end-to-end checkout — the one flow that genuinely needs a real
// account. Uses the Part 3 test customer (never Naeem's own Google account).
// Places a REAL order against the live database (there's no separate test
// mode), so two things are guaranteed elsewhere rather than trusted here:
//   - Steadfast is never booked for it — booking is a separate, manual admin
//     action on a CONFIRMED order (see reports/batch-20.txt); this test never
//     touches the admin panel, so it structurally can't happen.
//   - Naeem's Telegram never fires for it — notify-telegram-order skips any
//     order whose customer_id matches this fixed test account (see the
//     E2E_TEST_CUSTOMER_ID check added to that function this batch).
// The order is cancelled at the end (a real, customer-permitted action) but
// deliberately NOT hard-deleted here — hard-deleting needs the admin-only
// function Part 4 adds, and giving this test suite that level of access
// would mean holding a full-bypass service-role key just for tidiness.
// Cancelled e2e orders are exactly what Part 4's new bulk-delete screen is
// for; see reports/batch-21.txt Part 3/4 for this trade-off spelled out.

test.describe('Logged-in checkout', () => {
  test('add to cart, complete checkout, see the order in My Orders, cancel it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInAsTestCustomer(page);
    await page.goto('/');
    await page.waitForSelector('.product-card');

    // Empty the cart from any previous run first, so quantities don't drift.
    await page.goto('/cart');
    let removeGuard = 0;
    while (
      (await page.locator('.checkout-cart__thumb').count()) > 0 &&
      removeGuard < 20
    ) {
      const decrease = page.getByRole('button', { name: /^Decrease quantity of /i }).first();
      if ((await decrease.count()) === 0) break;
      await decrease.click();
      await page.waitForTimeout(100);
      const confirmRemove = page.getByRole('button', { name: 'Remove', exact: true });
      if (await confirmRemove.isVisible().catch(() => false)) {
        await confirmRemove.click();
        await page.waitForTimeout(100);
      }
      removeGuard += 1;
    }

    await page.goto('/');
    const addButton = page.getByRole('button', { name: /^Add .* to cart$/ }).first();
    const productName = (await addButton.getAttribute('aria-label'))!
      .replace(/^Add /, '')
      .replace(/ to cart$/, '');
    await addButton.click();

    await page.locator('.bottom-nav__tab').filter({ hasText: 'Cart' }).click();
    await expect(page).toHaveURL(/\/cart/);
    await page.getByRole('button', { name: 'Checkout' }).click();
    await expect(page).toHaveURL(/\/checkout\/delivery/);

    // Zone card — any of them is fine, this just needs to be a deterministic,
    // valid choice rather than relying on a random division/district/thana
    // combination happening to map to a covered delivery zone.
    await page.locator('.checkout-zone-card').first().click();

    await page.getByLabel(/Full name/).fill('E2E Test Customer');
    await page.getByLabel(/Phone number/).fill('01712345678');

    await page.locator('#delivery-form-division, [id$="-division"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('.picker-sheet__row').first().click();
    await page.waitForTimeout(200);
    await page.locator('[id$="-district"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('.picker-sheet__row').first().click();
    await page.waitForTimeout(200);
    await page.locator('[id$="-thana"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('.picker-sheet__row').first().click();
    await page.waitForTimeout(200);

    await page.getByLabel(/House \/ road \/ landmark/).fill('123 Test Road, near the test landmark');

    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/checkout\/summary/);

    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/checkout\/success/, { timeout: 15_000 });

    await page.goto('/orders');
    // The list shows each order's number/date/total, not its line items —
    // the order just placed is the newest, so the first row.
    await expect(page.locator('.orders-list__number').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('a[href^="/orders/"]').first().click();
    await expect(page).toHaveURL(/\/orders\//);
    void productName;

    await page.getByRole('button', { name: 'Cancel order' }).click();
    // Confirms inside a dialog whose own confirm button carries the same
    // label — see OrderDetailPage's ConfirmDialog confirmLabel.
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText(/cancelled|বাতিল/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
