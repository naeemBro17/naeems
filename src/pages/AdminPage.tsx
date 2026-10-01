import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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
import type { WholesalerAccount, Order } from '../types';
import '../styles/admin.css';

export function AdminPage() {
  const { isAdmin, can, staff, refreshStaff } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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
  const active: AdminSection =
    (ALL_SECTIONS as readonly string[]).includes(requested) && canOpenSection(requested, access) ? requested : 'home';
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
      if (`?${search}` === location.search || (search === '' && location.search === '')) return;
      navigate({ search: search === '' ? '' : `?${search}` });
      window.scrollTo(0, 0);
      // A moderator's permissions can change while they are signed in —
      // re-read them whenever they change section.
      if (!isAdmin) void refreshStaff();
    },
    [navigate, location.search, isAdmin, refreshStaff]
  );

  const pendingOrders = orders.filter((o) => o.status === 'pending').length;
  const title = adminTitle(isAdmin === true, roleName);

  return (
    <SafetyLockProvider>
      <AdminLayout
        active={active}
        items={items}
        tabs={tabs}
        title={title}
        username={staff?.username ?? null}
        banner={isAdmin ? <SafetyLockBar /> : null}
        onNavigate={(section) => goTo(section)}
        pendingOrders={pendingOrders}
      >
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
        {active === 'import-export' && <CSVImport />}
        {active === 'wholesalers' && (
          <WholesalerList accounts={wholesalers} onReload={loadWholesalers} readOnly={!isAdmin} />
        )}
        {active === 'orders' && (
          <OrdersTab key={orderParam ?? 'list'} orders={orders} onReload={loadOrders} initialOrderId={orderParam} />
        )}
        {active === 'customers' && <CustomersTab onOpenOrder={(id) => goTo('orders', { order: id })} />}
        {active === 'reviews' && <ReviewsTab />}
        {active === 'bento' && <BentoTilesTab />}
        {active === 'design' && <BannerTextsTab />}
        {active === 'promo-codes' && <PromoCodesTab />}
        {active === 'settings' && <SettingsTab />}
        {active === 'team' && <TeamTab />}
        {active === 'activity' && <ActivityLogTab />}
        {active === 'profile' && <MyProfileTab />}
      </AdminLayout>
    </SafetyLockProvider>
  );
}
