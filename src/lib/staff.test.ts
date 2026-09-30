import { describe, expect, it } from 'vitest';
import { staffEmail, togglePermission } from './staff';
import { siteText } from './editableTexts';

describe('togglePermission', () => {
  it('turns on View orders together with any order permission', () => {
    expect(togglePermission([], 'delete_early_orders')).toEqual(['view_orders', 'delete_early_orders']);
  });

  it('turning View orders off also turns off the order permissions that need it', () => {
    expect(togglePermission(['view_orders', 'change_order_status', 'edit_products'], 'view_orders')).toEqual([
      'edit_products',
    ]);
  });

  it('leaves unrelated permissions alone', () => {
    expect(togglePermission(['edit_products'], 'edit_categories')).toEqual(['edit_products', 'edit_categories']);
  });
});

describe('staffEmail', () => {
  it('builds the internal login email the moderator never sees', () => {
    expect(staffEmail(' Rahim.K ')).toBe('rahim.k@staff.naeems.internal');
  });
});

describe('siteText', () => {
  it('falls back to the default when the saved text is empty', () => {
    const blank = { text_checkout_signin_title: '  ', text_checkout_signin_message: '' };
    expect(siteText(blank, 'text_checkout_signin_title')).toBe('Almost done!');
    expect(siteText(blank, 'text_checkout_signin_message')).toBe(
      'Before we send your skincare, we just need to know who you are.'
    );
  });

  it('uses the saved text when there is one', () => {
    const saved = { text_checkout_signin_title: 'One more step', text_checkout_signin_message: '' };
    expect(siteText(saved, 'text_checkout_signin_title')).toBe('One more step');
  });
});
