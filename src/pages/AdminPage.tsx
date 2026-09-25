import { useCallback, useEffect, useState } from 'react';
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
import { fetchAllOrders } from '../lib/orders';
import type { WholesalerAccount, Order } from '../types';

export function AdminPage() {
  const [activeTab, setActiveTab] = useState<AdminTab>('products');
  const [wholesalers, setWholesalers] = useState<WholesalerAccount[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);

  // Loaded once for the pending-count badge and reused by the Wholesalers tab.
  const loadWholesalers = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_list_profiles');
    if (!error && data) {
      setWholesalers(data as WholesalerAccount[]);
    }
  }, []);

  // Same pattern as loadWholesalers: loaded once here, passed down to
  // OrdersTab, and re-run after any change (status update, cancel) so both
  // the tab's own list and the sidebar's pending-count badge stay in sync.
  const loadOrders = useCallback(async () => {
    setOrders(await fetchAllOrders());
  }, []);

  useEffect(() => {
    void loadWholesalers();
    void loadOrders();
  }, [loadWholesalers, loadOrders]);

  // A client-side navigation (e.g. the hamburger menu's Admin Panel link)
  // keeps whatever scroll position the previous page was at — this page
  // never got its own reset, unlike ProductDetailPage's equivalent effect,
  // which is what made landing here look like a jump/bounce from wherever
  // the home grid had been scrolled to. Runs once, on mount, not per tab
  // switch.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const pendingWholesalers = wholesalers.filter(
    (w) => w.role === 'wholesaler' && w.status === 'pending'
  ).length;
  const pendingOrders = orders.filter((o) => o.status === 'pending').length;

  return (
    <AdminLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      pendingWholesalers={pendingWholesalers}
      pendingOrders={pendingOrders}
    >
      {activeTab === 'products' && <ProductList />}
      {activeTab === 'categories' && (
        <>
          <CategoryManager />
          <RegionSizeManager />
        </>
      )}
      {activeTab === 'import-export' && <CSVImport />}
      {activeTab === 'wholesalers' && (
        <WholesalerList accounts={wholesalers} onReload={loadWholesalers} />
      )}
      {activeTab === 'orders' && <OrdersTab orders={orders} onReload={loadOrders} />}
      {activeTab === 'reviews' && <ReviewsTab />}
      {activeTab === 'bento' && <BentoTilesTab />}
      {activeTab === 'promo-codes' && <PromoCodesTab />}
      {activeTab === 'settings' && <SettingsTab />}
    </AdminLayout>
  );
}
