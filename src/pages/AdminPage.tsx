import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { AdminPageHeader } from '../components/admin/ui/AdminUi';
import { fetchAllOrders } from '../lib/orders';
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
import { ProductEditPage } from '../components/admin/pages/ProductEditPage';
import { CustomerPage } from '../components/admin/pages/CustomerPage';
import { NewCustomerPage } from '../components/admin/pages/NewCustomerPage';
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

export function AdminPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Batch 32 Part 3: /admin/orders/new, /admin/products/:id/edit, … are
  // pages of their own inside the same admin shell.
  const sub = parseAdminSubPage(location.pathname);
  const fallback = sub !== null && sub !== 'unknown' ? subPageFallback(sub) : '/admin';
  const onBack = useCallback(() => goBackFromSubPage(navigate, location, fallback), [navigate, location, fallback]);
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
  const { isAdmin, can, staff, refreshStaff } = useAuth();
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
  const [orders, setOrders] = useState<Order[]>([]);
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
    setOrders(await fetchAllOrders());
  }, [canViewOrders]);

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

  /** Opens an order's detail on the Orders list (after New / Edit order). */
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
        hideTabbar={sub !== null && isFormSubPage(sub)}
      >
        {sub?.kind === 'new-order' && (
          <NewOrderPage
            onBack={back}
            onCreated={async (orderId) => {
              await loadOrders();
              openOrder(orderId);
            }}
          />
        )}
        {sub?.kind === 'edit-order' && (
          <EditOrderPage key={sub.orderNumber} orderNumber={sub.orderNumber} onBack={back} onDone={openOrder} />
        )}
        {(sub?.kind === 'new-product' || sub?.kind === 'edit-product') && (
          <ProductEditPage
            productId={sub.kind === 'edit-product' ? sub.productId : null}
            onBack={back}
            onDone={() => leave(onBack)}
          />
        )}
        {sub?.kind === 'customer' && (
          <CustomerPage
            key={sub.customerKey}
            customerKey={sub.customerKey}
            onBack={back}
            onOpenOrder={(id) => navigate(`/admin?tab=orders&order=${encodeURIComponent(id)}`)}
            onDeleted={() => leave(onBack)}
          />
        )}
        {sub?.kind === 'new-customer' && (
          <NewCustomerPage
            onBack={back}
            onOpenCustomer={(key) => leave(() => navigate(adminPath.customer(key), { replace: true, state: { fromList: true } }))}
          />
        )}
        {!sub && (
        <>
        {active === 'home' && <HomeTab title={title} onOpen={goTo} />}
        {active === 'more' && <MoreTab items={more} username={staff?.username ?? null} onOpen={goTo} />}
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
        {active === 'customers' && <CustomersTab />}
        {active === 'reviews' && <ReviewsTab />}
        {active === 'bento' && <BentoTilesTab />}
        {active === 'design' && <BannerTextsTab />}
        {active === 'promo-codes' && <PromoCodesTab />}
        {active === 'settings' && <SettingsTab />}
        {active === 'team' && <TeamTab />}
        {active === 'activity' && <ActivityLogTab />}
        {active === 'profile' && <MyProfileTab />}
        </>
        )}
      </AdminLayout>
  );
}
