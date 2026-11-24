import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useProducts } from '../../contexts/ProductContext';
import { fetchStockUnits, packKey } from '../../lib/inventory/api';
import type { StockUnit } from '../../lib/inventory/types';
import { packStockText } from '../../lib/inventory/unitText';

/**
 * Batch 62: every product's stock unit, pack size and units in lots (one
 * read, "View profit & costs" only; empty otherwise), for the stock line
 * of admin New order / Edit order.
 */
export function useStockUnitsMap(): Map<string, StockUnit> {
  const { can } = useAuth();
  const allowed = can('view_profit_costs');
  const [map, setMap] = useState<Map<string, StockUnit>>(() => new Map());
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void fetchStockUnits().then((answer) => {
      if (cancelled || answer.kind !== 'ready') return;
      setMap(new Map(answer.data.map((u) => [packKey(u.product_id, u.variant_id), u])));
    });
    return () => {
      cancelled = true;
    };
  }, [allowed]);
  return map;
}

/**
 * "Stock: 1 bottle (473 ml)" / "Stock: 0 bottles + 300 ml" / "Stock: 4
 * bottles (1,600 tab)" under an order line, for a product sold in packs of
 * more than one unit. Inventory mode On: the units in lots; Off: the
 * shop's stock number of whole packs. Nothing for other products.
 */
export function PackStockLine({ units, productId, variantId }: { units: Map<string, StockUnit>; productId: string | null; variantId: string | null }) {
  const { settings } = useProducts();
  if (!productId) return null;
  const row = units.get(packKey(productId, variantId));
  if (!row || row.pack_size <= 1) return null;
  const modeOn = settings.inventory_mode === 'true';
  const all = modeOn ? row.lot_pieces_left : row.site_stock === null ? null : row.site_stock * row.pack_size;
  if (all === null) return null;
  const text = packStockText(all, row.pack_size, row.stock_unit);
  if (!text) return null;
  return (
    <span className="checkout-cart__variant pack-stock-line" data-testid="line-pack-stock">
      {text}
    </span>
  );
}
