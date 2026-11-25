import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { AdminLayout } from '../components/admin/AdminLayout';
import { ProductList } from '../components/admin/ProductList';
import { CategoryManager } from '../components/admin/CategoryManager';
import { RegionSizeManager } from '../components/admin/RegionSizeManager';
import { CSVImport } from '../components/admin/CSVImport';
import { WholesalerList } from '../components/admin/WholesalerList';
import { ReviewsTab } from '../components/admin/ReviewsTab';
import { BentoTilesTab } from '../components/admin/BentoTilesTab';
import { PromoCodesTab } from '../components/admin/PromoCodesTab';
import { SettingsTab } from '../components/admin/SettingsTab';
import { OrdersTab } from '../components/admin/OrdersTab';
import { TeamTab } from '../components/admin/TeamTab';
import { ActivityLogTab } from '../components/admin/ActivityLogTab';
import { MyProfileTab } from '../components/admin/MyProfileTab';
import { HomeTab } from '../components/admin/HomeTab';
import { MoreTab } from '../components/admin/MoreTab';
import { CustomersTab } from '../components/admin/CustomersTab';
import { BannerTextsTab } from '../components/admin/BannerTextsTab';
import { BrandsTab } from '../components/admin/BrandsTab';
import { PayoutsTab } from '../components/admin/PayoutsTab';
import { ShoppingListTab } from '../components/admin/ShoppingListTab';
import { CombosTab } from '../components/admin/CombosTab';
import { CampaignsTab } from '../components/admin/campaigns/CampaignsTab';
import { CampaignEditorPage } from '../components/admin/campaigns/CampaignEditorPage';
import { fetchShoppingList, type ShoppingLoad } from '../lib/shoppingList';
import { InventoryTab } from '../components/admin/inventory/InventoryTab';
import { MoneyTab } from '../components/admin/money/MoneyTab';
import { ReportsTab } from '../components/admin/reports/ReportsTab';
import { KaarbarImportTab } from '../components/admin/kaarbar/KaarbarImportTab';
import { AdminPageHeader } from '../components/admin/ui/AdminUi';
import { fetchAllOrders } from '../lib/orders';
import { isFresh, readSwr, writeSwr } from '../lib/swrCache';
import { fetchOwnRoleName } from '../lib/staff';
import {
  ALL_SECTIONS,
  adminTitle,
  bottomTabs,
  canOpenSection,
  moreItems,
  visibleNavItems,
  type AdminSection,
} from '../lib/adminNav';
import { useAuth } from '../contexts/AuthContext';
import { SafetyLockBar, SafetyLockProvider } from '../contexts/SafetyLockContext';
import { LeaveGuardProvider, useLeaveGuard } from '../components/admin/LeaveGuard';
import { NewOrderPage } from '../components/admin/pages/NewOrderPage';
import { EditOrderPage } from '../components/admin/pages/EditOrderPage';
import { OrderPage } from '../components/admin/pages/OrderPage';
import { ProductEditPage } from '../components/admin/pages/ProductEditPage';
import { CustomerPage } from '../components/admin/pages/CustomerPage';
import { NewCustomerPage } from '../components/admin/pages/NewCustomerPage';
import { PayoutPage } from '../components/admin/pages/PayoutPage';
import { MergeReviewPage } from '../components/admin/kaarbar/merge/MergeReviewPage';
import { JoinCustomerPage } from '../components/admin/pages/JoinCustomerPage';
import { MergeReceiptPage, OldReceiptPage } from '../components/admin/kaarbar/merge/MergeReceiptPage';
import { goBackFromSubPage } from '../components/admin/pages/subPageBack';
import {
  adminPath,
  canOpenSubPage,
  isFormSubPage,
  parseAdminSubPage,
  subPageFallback,
  subPageSection,
  type AdminSubPage,
} from '../lib/adminPages';
import type { WholesalerAccount, Order } from '../types';
import '../styles/admin.css';
import '../styles/adminOrders.css';
// Batch 63: Admin → New order's new look (after the admin styles above,
// which it adjusts on that page only).
import '../styles/batch63.css';
// Batch 65: Note to customer card and the Mark returned amount.
import '../styles/batch65-admin.css';
// Batch 66: Campaigns list and editor.
import '../styles/batch66-admin.css';

export function AdminPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Batch 32 Part 3: /admin/orders/new, /admin/products/:id/edit, … are
  // pages of their own inside the same admin shell.
  const sub = parseAdminSubPage(location.pathname);
  const fallback = sub !== null && sub !== 'unknown' ? subPageFallback(sub) : '/admin';
  const onBack = useCallback(() => goBackFromSubPage(navigate, location, fallback), [navigate, location, fallback]);
  // Batch 66: /admin/campaigns is the Campaigns list.
  if (location.pathname.replace(/\/+$/, '') === '/admin/campaigns') return <Navigate to="/admin?tab=campaigns" replace />;
  if (sub === 'unknown') return <Navigate to="/admin" replace />;
  return (
    <SafetyLockProvider>
      <LeaveGuardProvider key={location.pathname} onBack={onBack}>
        <AdminPageContent sub={sub} onBack={onBack} />
      </LeaveGuardProvider>
    </SafetyLockProvider>
  );
}

function AdminPageContent({ sub, onBack }: { sub: AdminSubPage | null; onBack: () => void }) {
  const { isAdmin, can, staff, refreshStaff, session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { requestLeave, leave } = useLeaveGuard();
  const [searchParams] = useSearchParams();
  const [roleName, setRoleName] = useState<string | null>(null);

  // Batch 25: one list decides the sidebar, the bottom bar and the More
  // page (lib/adminNav.ts). The database refuses the same actions anyway.
  const access = useMemo(() => ({ isAdmin: isAdmin === true, can }), [isAdmin, can]);
  const items = useMemo(() => visibleNavItems(access), [access]);
  const tabs = useMemo(() => bottomTabs(items), [items]);
  const more = useMemo(() => moreItems(items, tabs), [items, tabs]);

  // The open section lives in the URL (?tab=...) — which also keeps a deep
  // link like /admin?tab=orders&order=<uuid> from the Telegram order
  // notification working — so phone Back and refresh keep your place.
  const requested = (searchParams.get('tab') ?? '') as AdminSection;
  const subAllowed = sub !== null && canOpenSubPage(sub, access);
  const active: AdminSection = sub
    ? subPageSection(sub)
    : (ALL_SECTIONS as readonly string[]).includes(requested) && canOpenSection(requested, access)
      ? requested
      : 'home';
  const orderParam = searchParams.get('order');

  const [wholesalers, setWholesalers] = useState<WholesalerAccount[]>([]);
  // Batch 62: the last copy of the orders shows at once; fresh replaces it.
  const ordersCopyKey = session ? `admin-orders:${session.user.id}` : null;
  const [orders, setOrders] = useState<Order[]>(() => (ordersCopyKey ? readSwr<Order[]>(ordersCopyKey)?.data ?? [] : []));
  const ordersFetchedAt = useRef(0);
  const canViewOrders = can('view_orders');
  const canViewWholesalers = can('view_wholesalers');

  // The admin's own look for toasts (they render outside the admin shell).
  useEffect(() => {
    document.documentElement.dataset.admin = 'true';
    return () => {
      delete document.documentElement.dataset.admin;
    };
  }, []);

  useEffect(() => {
    if (isAdmin) return;
    let alive = true;
    void fetchOwnRoleName().then((name) => {
      if (alive) setRoleName(name);
    });
    return () => {
      alive = false;
    };
  }, [isAdmin, staff]);

  const loadWholesalers = useCallback(async () => {
    if (!canViewWholesalers) return;
    const { data, error } = await supabase.rpc('admin_list_profiles');
    if (!error && data) {
      setWholesalers(data as WholesalerAccount[]);
    }
  }, [canViewWholesalers]);

  // Loaded once here and passed down to OrdersTab, and re-run after any
  // change so both the list and the "to confirm" badge stay in sync.
  const loadOrders = useCallback(async () => {
    if (!canViewOrders) return;
    ordersFetchedAt.current = Date.now();
    const fresh = await fetchAllOrders();
    setOrders(fresh);
    if (ordersCopyKey) writeSwr<Order[]>(ordersCopyKey, fresh);
  }, [canViewOrders, ordersCopyKey]);

  // Batch 62: back in the app after more than 60 seconds: the orders again.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || ordersFetchedAt.current === 0 || isFresh(ordersFetchedAt.current)) return;
      void loadOrders();
    };
    document.addEventListener('visibilitychange', onReturn);
    return () => document.removeEventListener('visibilitychange', onReturn);
  }, [loadOrders]);

  // Batch 51: the Shopping list — its count is the badge, Home's tile and
  // the list page. Read again whenever the orders are.
  const [shopping, setShopping] = useState<ShoppingLoad | null>(null);
  const loadShopping = useCallback(async () => {
    if (!canViewOrders) return;
    setShopping(await fetchShoppingList());
  }, [canViewOrders]);
  useEffect(() => {
    void loadShopping();
  }, [loadShopping, orders]);
  const shoppingCount = shopping?.kind === 'ready' ? shopping.rows.length : 0;

  useEffect(() => {
    void loadWholesalers();
    void loadOrders();
  }, [loadWholesalers, loadOrders]);

  /** Opens a section (a new history entry, so phone Back returns here),
   *  optionally already filtered. */
  const goTo = useCallback(
    (section: AdminSection, params: Record<string, string> = {}) => {
      const next = new URLSearchParams();
      if (section !== 'home') next.set('tab', section);
      for (const [key, value] of Object.entries(params)) next.set(key, value);
      const search = next.toString();
      if (!sub && (`?${search}` === location.search || (search === '' && location.search === ''))) return;
      // Batch 32: leaving a page with typed changes asks first.
      requestLeave(() => {
        navigate({ pathname: '/admin', search: search === '' ? '' : `?${search}` });
        window.scrollTo(0, 0);
        // A moderator's permissions can change while they are signed in —
        // re-read them whenever they change section.
        if (!isAdmin) void refreshStaff();
      });
    },
    [navigate, location.search, isAdmin, refreshStaff, sub, requestLeave]
  );

  /** Opens an order (after New / Edit order) — the Orders list turns the
   *  ?order= link into the order's own page (Batch 35). */
  const openOrder = useCallback(
    (orderId: string) => leave(() => navigate(`/admin?tab=orders&order=${encodeURIComponent(orderId)}`, { replace: true })),
    [leave, navigate]
  );
  const back = useCallback(() => requestLeave(onBack), [requestLeave, onBack]);

  if (sub && !subAllowed) return <Navigate to="/admin" replace />;

  const pendingOrders = orders.filter((o) => o.status === 'pending').length;
  const title = adminTitle(isAdmin === true, roleName);

  return (
      <AdminLayout
        active={active}
        items={items}
        tabs={tabs}
        title={title}
        username={staff?.username ?? null}
        banner={isAdmin ? <SafetyLockBar /> : null}
        onNavigate={(section) => goTo(section)}
        pendingOrders={pendingOrders}
        shoppingCount={shoppingCount}
        hideTabbar={sub !== null && isFormSubPage(sub)}
      >
        {sub?.kind === 'new-order' && (
          <NewOrderPage
            onBack={back}
            onCreated={(orderId) => openOrder(orderId)}
          />
        )}
        {sub?.kind === 'order' && (
          <OrderPage key={sub.orderNumber} orderNumber={sub.orderNumber} onBack={back} onChanged={() => void loadOrders()} />
        )}
        {sub?.kind === 'edit-order' && (
          <EditOrderPage key={sub.orderNumber} orderNumber={sub.orderNumber} onBack={back} onDone={openOrder} />
        )}
        {(sub?.kind === 'new-product' || sub?.kind === 'edit-product') && (
          <ProductEditPage
            key={sub.kind === 'edit-product' ? sub.productId : 'new'}
            productId={sub.kind === 'edit-product' ? sub.productId : null}
            onBack={back}
            onCreated={(id) =>
              leave(() => navigate(adminPath.editProduct(id), { replace: true, state: location.state as unknown }))
            }
          />
        )}
        {sub?.kind === 'customer' && (
          <CustomerPage
            key={sub.customerKey}
            customerKey={sub.customerKey}
            onBack={back}
            onOpenOrder={(orderNumber) => navigate(adminPath.order(orderNumber), { state: { fromList: true } })}
            onDeleted={() => leave(() => navigate('/admin?tab=customers', { replace: true }))}
            onOpenJoin={(pickKey) => navigate(adminPath.customerJoin(sub.customerKey, pickKey), { state: { fromList: true } })}
          />
        )}
        {/* Batch 55: Merge with another customer. Merge goes back where it was opened from. */}
        {sub?.kind === 'join-customer' && (
          <JoinCustomerPage
            key={`${sub.customerKey}|${location.search}`}
            customerKey={sub.customerKey}
            pickKey={new URLSearchParams(location.search).get('pick')}
            onBack={back}
            onMerged={() => leave(onBack)}
          />
        )}
        {/* Batch 54: Merge old data. Opening a receipt keeps the statement in
            memory, so it leaves without asking; Merge goes back to the customer. */}
        {sub?.kind === 'merge-old' && (
          <MergeReviewPage
            key={sub.customerKey}
            customerKey={sub.customerKey}
            onBack={back}
            onOpenReceipt={(bill) => leave(() => navigate(adminPath.mergeReceipt(sub.customerKey, bill), { state: { fromList: true } }))}
            onMerged={() => leave(onBack)}
            onWrongCustomer={() => leave(onBack)}
            onOpenJoin={(pickKey) => leave(() => navigate(adminPath.customerJoin(sub.customerKey, pickKey), { state: { fromList: true } }))}
          />
        )}
        {sub?.kind === 'merge-receipt' && (
          <MergeReceiptPage key={sub.bill} customerKey={sub.customerKey} bill={sub.bill} onBack={back} />
        )}
        {sub?.kind === 'old-receipt' && (
          <OldReceiptPage key={sub.billId} customerKey={sub.customerKey} billId={sub.billId} onBack={back} />
        )}
        {sub?.kind === 'payout' && (
          <PayoutPage
            key={sub.payoutId}
            payoutId={sub.payoutId}
            onBack={back}
            onOpenOrder={(orderNumber) => navigate(adminPath.order(orderNumber), { state: { fromList: true } })}
          />
        )}
        {sub?.kind === 'new-customer' && (
          <NewCustomerPage
            onBack={back}
            onOpenCustomer={(key) =>
              leave(() => navigate(adminPath.customer(key), { replace: true, state: location.state as unknown }))
            }
          />
        )}
        {sub?.kind === 'new-campaign' && (
          <CampaignEditorPage campaignId={null} onBack={back} onDone={() => navigate('/admin?tab=campaigns', { replace: true })} />
        )}
        {sub?.kind === 'edit-campaign' && (
          <CampaignEditorPage
            key={sub.campaignId}
            campaignId={sub.campaignId}
            onBack={back}
            onDone={() => navigate('/admin?tab=campaigns', { replace: true })}
          />
        )}
        {!sub && (
        <>
        {active === 'home' && <HomeTab title={title} onOpen={goTo} shoppingCount={shoppingCount} />}
        {active === 'more' && (
          <MoreTab items={more} username={staff?.username ?? null} onOpen={goTo} shoppingCount={shoppingCount} />
        )}
        {active === 'shopping' && (
          <ShoppingListTab
            list={shopping}
            onReload={() => void loadShopping()}
            onOpenOrder={(orderNumber) => navigate(adminPath.order(orderNumber), { state: { fromList: true } })}
          />
        )}
        {active === 'combos' && <CombosTab />}
        {active === 'products' && <ProductList />}
        {active === 'categories' && (
          <>
            <AdminPageHeader title="Categories" />
            {can('edit_categories') && <CategoryManager />}
            {can('edit_products') && <RegionSizeManager />}
          </>
        )}
        {active === 'brands' && <BrandsTab />}
        {active === 'import-export' && <CSVImport />}
        {active === 'wholesalers' && (
          <WholesalerList accounts={wholesalers} onReload={loadWholesalers} readOnly={!isAdmin} />
        )}
        {active === 'orders' && (
          <OrdersTab key={orderParam ?? 'list'} orders={orders} onReload={loadOrders} initialOrderId={orderParam} />
        )}
        {active === 'payouts' && (
          <PayoutsTab
            onOpenPayout={(id) => navigate(adminPath.payout(id), { state: { fromList: true } })}
            onOpenOrder={(orderNumber) => navigate(adminPath.order(orderNumber), { state: { fromList: true } })}
          />
        )}
        {active === 'inventory' && <InventoryTab />}
        {active === 'money' && <MoneyTab />}
        {active === 'reports' && <ReportsTab />}
        {active === 'customers' && <CustomersTab />}
        {active === 'reviews' && <ReviewsTab />}
        {active === 'bento' && <BentoTilesTab />}
        {active === 'design' && <BannerTextsTab />}
        {active === 'promo-codes' && <PromoCodesTab />}
        {active === 'campaigns' && <CampaignsTab />}
        {active === 'settings' && <SettingsTab />}
        {active === 'team' && <TeamTab />}
        {active === 'activity' && <ActivityLogTab />}
        {active === 'kaarbar' && <KaarbarImportTab />}
        {active === 'profile' && <MyProfileTab />}
        </>
        )}
      </AdminLayout>
  );
}
