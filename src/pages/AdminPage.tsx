import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AdminLayout, type AdminTab } from '../components/admin/AdminLayout';
import { ProductList } from '../components/admin/ProductList';
import { CategoryManager } from '../components/admin/CategoryManager';
import { CSVImport } from '../components/admin/CSVImport';
import { WholesalerList } from '../components/admin/WholesalerList';
import { ReviewsTab } from '../components/admin/ReviewsTab';
import { BentoTilesTab } from '../components/admin/BentoTilesTab';
import { SettingsTab } from '../components/admin/SettingsTab';
import type { WholesalerAccount } from '../types';

export function AdminPage() {
  const [activeTab, setActiveTab] = useState<AdminTab>('products');
  const [wholesalers, setWholesalers] = useState<WholesalerAccount[]>([]);

  // Loaded once for the pending-count badge and reused by the Wholesalers tab.
  const loadWholesalers = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_list_profiles');
    if (!error && data) {
      setWholesalers(data as WholesalerAccount[]);
    }
  }, []);

  useEffect(() => {
    void loadWholesalers();
  }, [loadWholesalers]);

  const pendingWholesalers = wholesalers.filter(
    (w) => w.role === 'wholesaler' && w.status === 'pending'
  ).length;

  return (
    <AdminLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      pendingWholesalers={pendingWholesalers}
    >
      {activeTab === 'products' && <ProductList />}
      {activeTab === 'categories' && <CategoryManager />}
      {activeTab === 'import-export' && <CSVImport />}
      {activeTab === 'wholesalers' && (
        <WholesalerList accounts={wholesalers} onReload={loadWholesalers} />
      )}
      {activeTab === 'reviews' && <ReviewsTab />}
      {activeTab === 'bento' && <BentoTilesTab />}
      {activeTab === 'settings' && <SettingsTab />}
    </AdminLayout>
  );
}
