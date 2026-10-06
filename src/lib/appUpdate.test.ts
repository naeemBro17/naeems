import { describe, expect, it } from 'vitest';
import { AppUpdateController, isCheckoutPath, isSafeMoment, type PageState } from './appUpdate';

function setup(start: Partial<PageState> = {}) {
  const page: PageState = { pathname: '/', dialogOpen: false, editing: false, typedOnPage: false, ...start };
  let hidden = false;
  let time = 0;
  const log = { applied: 0, checks: 0 };
  const controller = new AppUpdateController({
    applyUpdate: () => log.applied++,
    checkForUpdate: () => log.checks++,
    pageState: () => page,
    isHidden: () => hidden,
    now: () => time,
  });
  return {
    controller,
    page,
    log,
    hide: (h: boolean) => (hidden = h),
    advance: (ms: number) => (time += ms),
  };
}

describe('Batch 31 Part 7: app updates apply only at a safe moment', () => {
  it('knows the checkout pages', () => {
    for (const p of ['/cart', '/checkout/delivery', '/checkout/summary', '/checkout/success']) expect(isCheckoutPath(p)).toBe(true);
    for (const p of ['/', '/product/x', '/admin', '/cartoon']) expect(isCheckoutPath(p)).toBe(false);
  });

  it('safe = not checkout, no open sheet, no cursor in a field, nothing typed', () => {
    const base: PageState = { pathname: '/', dialogOpen: false, editing: false, typedOnPage: false };
    expect(isSafeMoment(base)).toBe(true);
    expect(isSafeMoment({ ...base, pathname: '/checkout/summary' })).toBe(false);
    expect(isSafeMoment({ ...base, dialogOpen: true })).toBe(false);
    expect(isSafeMoment({ ...base, editing: true })).toBe(false);
    expect(isSafeMoment({ ...base, typedOnPage: true })).toBe(false);
  });

  it('just opened and untouched → applies at once', () => {
    const t = setup();
    t.controller.onUpdateReady();
    expect(t.log.applied).toBe(1);
  });

  it('in use → waits for the next page change', () => {
    const t = setup({ pathname: '/product/a' });
    t.controller.onInteraction();
    t.controller.onUpdateReady();
    expect(t.log.applied).toBe(0);
    t.page.pathname = '/product/b';
    t.controller.onNavigate();
    expect(t.log.applied).toBe(1);
    t.controller.onNavigate();
    expect(t.log.applied).toBe(1);
  });

  it('never during checkout — not even when the app goes to the background', () => {
    const t = setup({ pathname: '/cart' });
    t.controller.onInteraction();
    t.controller.onUpdateReady();
    t.page.pathname = '/checkout/delivery';
    t.controller.onNavigate();
    t.page.pathname = '/checkout/summary';
    t.controller.onNavigate();
    t.hide(true);
    t.controller.onHidden();
    t.page.pathname = '/checkout/success';
    t.controller.onNavigate();
    expect(t.log.applied).toBe(0);
    // Back to the shop: now it may.
    t.hide(false);
    t.page.pathname = '/';
    t.controller.onNavigate();
    expect(t.log.applied).toBe(1);
  });

  it('never while a sheet is open or something was typed (admin editing)', () => {
    const t = setup({ pathname: '/admin' });
    t.controller.onTyped();
    t.controller.onUpdateReady();
    t.hide(true);
    t.controller.onHidden();
    expect(t.log.applied).toBe(0);
    t.hide(false);
    t.page.dialogOpen = true;
    t.controller.onNavigate();
    expect(t.log.applied).toBe(0);
    t.page.dialogOpen = false;
    t.controller.onNavigate();
    expect(t.log.applied).toBe(1);
  });

  it('in the background on a quiet page → applies', () => {
    const t = setup({ pathname: '/product/a' });
    t.controller.onInteraction();
    t.controller.onUpdateReady();
    expect(t.log.applied).toBe(0);
    t.hide(true);
    t.controller.onHidden();
    expect(t.log.applied).toBe(1);
  });

  it('checks on return to the app (at most once a minute) and every 30 minutes', () => {
    const t = setup();
    t.controller.check(true);
    expect(t.log.checks).toBe(1);
    t.controller.onVisible();
    expect(t.log.checks).toBe(1);
    t.advance(61_000);
    t.controller.onVisible();
    expect(t.log.checks).toBe(2);
    t.controller.onTimer();
    expect(t.log.checks).toBe(3);
    t.hide(true);
    t.controller.onTimer();
    expect(t.log.checks).toBe(3);
  });
});
