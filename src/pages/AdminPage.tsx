import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AdminLayout, type AdminTab } from '../components/admin/AdminLayout';
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
import { fetchAllOrders } from '../lib/orders';
import { useUrlParam } from '../hooks/useUrlParams';
import { useAuth } from '../contexts/AuthContext';
import { SafetyLockBar, SafetyLockProvider } from '../contexts/SafetyLockContext';
import type { WholesalerAccount, Order } from '../types';

const ADMIN_TABS: readonly AdminTab[] = [
  'products', 'categories', 'import-export', 'wholesalers', 'orders',
  'reviews', 'bento', 'promo-codes', 'settings', 'team', 'activity', 'profile',
];

export function AdminPage() {
  const { isAdmin, isModerator, can, staff, refreshStaff } = useAuth();

  // Batch 24: a moderator only sees the sections their permissions allow.
  // Hiding a section is only for tidiness — the database refuses the same
  // actions for them anyway.
  const visibleTabs = useMemo<AdminTab[]>(() => {
    if (isAdmin) return ADMIN_TABS.filter((t) => t !== 'profile');
    const tabs: AdminTab[] = [];
    if (can('view_orders')) tabs.push('orders');
    if (can('edit_products')) tabs.push('products');
    if (can('edit_categories') || can('edit_products')) tabs.push('categories');
    if (can('view_customers')) tabs.push('wholesalers');
    if (isModerator) tabs.push('profile');
    return tabs;
  }, [isAdmin, isModerator, can]);

  // The open tab lives in the URL (?tab=...) — which also keeps supporting a
  // deep link like /admin?tab=orders&order=<uuid> from the Telegram order
  // notification — so Back from a page opened out of the admin panel returns
  // to the same tab, not always Products.
  const defaultTab: AdminTab = visibleTabs.includes('products') ? 'products' : (visibleTabs[0] ?? 'profile');
  const [activeTab, setActiveTab] = useUrlParam<AdminTab>('tab', defaultTab, visibleTabs);
  const [wholesalers, setWholesalers] = useState<WholesalerAccount[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const initialOrderId = useMemo(() => new URLSearchParams(window.location.search).get('order'), []);
  const canViewOrders = can('view_orders');
  const canViewCustomers = can('view_customers');

  // Loaded once for the pending-count badge and reused by the Wholesalers tab.
  const loadWholesalers = useCallback(async () => {
    if (!canViewCustomers) return;
    const { data, error } = await supabase.rpc('admin_list_profiles');
    if (!error && data) {
      setWholesalers(data as WholesalerAccount[]);
    }
  }, [canViewCustomers]);

  // Same pattern as loadWholesalers: loaded once here, passed down to
  // OrdersTab, and re-run after any change (status update, cancel) so both
  // the tab's own list and the sidebar's pending-count badge stay in sync.
  const loadOrders = useCallback(async () => {
    if (!canViewOrders) return;
    setOrders(await fetchAllOrders());
  }, [canViewOrders]);

  useEffect(() => {
    void loadWholesalers();
    void loadOrders();
  }, [loadWholesalers, loadOrders]);

  // A moderator's permissions can change (or their account be switched off)
  // while they are signed in — re-read them whenever they change section.
  const handleTabChange = useCallback(
    (tab: AdminTab) => {
      setActiveTab(tab);
      if (!isAdmin) void refreshStaff();
    },
    [setActiveTab, isAdmin, refreshStaff]
  );

  const pendingWholesalers = wholesalers.filter(
    (w) => w.role === 'wholesaler' && w.status === 'pending'
  ).length;
  const pendingOrders = orders.filter((o) => o.status === 'pending').length;

  return (
    <SafetyLockProvider>
      <AdminLayout
        activeTab={activeTab}
        visibleTabs={visibleTabs}
        username={staff?.username ?? null}
        banner={isAdmin ? <SafetyLockBar /> : null}
        onTabChange={handleTabChange}
        pendingWholesalers={pendingWholesalers}
        pendingOrders={pendingOrders}
      >
        {activeTab === 'products' && <ProductList />}
        {activeTab === 'categories' && (
          <>
            {can('edit_categories') && <CategoryManager />}
            {can('edit_products') && <RegionSizeManager />}
          </>
        )}
        {activeTab === 'import-export' && <CSVImport />}
        {activeTab === 'wholesalers' && (
          <WholesalerList accounts={wholesalers} onReload={loadWholesalers} readOnly={!isAdmin} />
        )}
        {activeTab === 'orders' && (
          <OrdersTab orders={orders} onReload={loadOrders} initialOrderId={initialOrderId} />
        )}
        {activeTab === 'reviews' && <ReviewsTab />}
        {activeTab === 'bento' && <BentoTilesTab />}
        {activeTab === 'promo-codes' && <PromoCodesTab />}
        {activeTab === 'settings' && <SettingsTab />}
        {activeTab === 'team' && <TeamTab />}
        {activeTab === 'activity' && <ActivityLogTab />}
        {activeTab === 'profile' && <MyProfileTab />}
      </AdminLayout>
    </SafetyLockProvider>
  );
}
