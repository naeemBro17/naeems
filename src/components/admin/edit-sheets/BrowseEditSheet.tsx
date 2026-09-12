import { useEffect, useState, type FormEvent } from 'react';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { useReorder } from '../../../hooks/useReorder';
import { applyIdOrder, parseIdList, saveSettings, serializeIdList } from '../../../lib/settingsLists';
import { BottomSheet } from '../../shared/BottomSheet';
import { ReorderRow, SheetFooter, Toggle } from './SheetChrome';
import type { Category } from '../../../types';

interface BrowseEditSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Circles as currently displayed, so the list opens in the live order. */
  displayed: Category[];
}

interface Row {
  category: Category;
  visible: boolean;
}

/**
 * Which category circles show in Browse, and in what order. Saved as a JSON
 * array of the visible category ids; hidden categories are simply absent.
 * The Expert circle is fixed last and isn't part of the list.
 */
export function BrowseEditSheet({ isOpen, onClose, displayed }: BrowseEditSheetProps) {
  const { categories, settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [rows, setRows] = useState<Row[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const saved = parseIdList(settings.browse_categories_order);
    const shown = saved.length > 0 ? applyIdOrder(categories, saved, true) : displayed;
    const shownIds = new Set(shown.map((c) => c.id));
    setRows([
      ...shown.map((category) => ({ category, visible: true })),
      ...categories
        .filter((c) => !shownIds.has(c.id))
        .map((category) => ({ category, visible: false })),
    ]);
  }, [isOpen, categories, settings.browse_categories_order, displayed]);

  const reorder = useReorder(rows, setRows);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const visibleIds = rows.filter((r) => r.visible).map((r) => r.category.id);
    const error = await saveSettings({
      browse_categories_order: serializeIdList(visibleIds),
    });
    if (error) {
      console.error('Browse order save failed:', error);
      setIsSaving(false);
      showToast('Could not save the Browse row', 'error');
      return;
    }
    await refetch();
    setIsSaving(false);
    showToast('Saved');
    onClose();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Browse Categories">
      <form className="form edit-sheet" onSubmit={handleSave} noValidate>
        <p className="edit-sheet__hint">
          Toggle a category to show or hide its circle. The Expert circle always
          comes last.
        </p>

        <ul className="edit-list">
          {rows.map((row, index) => (
            <ReorderRow
              key={row.category.id}
              index={index}
              count={rows.length}
              dragIndex={reorder.dragIndex}
              onDragStart={reorder.setDragIndex}
              onDragEnd={() => reorder.setDragIndex(null)}
              onDrop={reorder.dropOn}
              onMove={reorder.move}
              label={row.category.name}
              className={row.visible ? undefined : 'edit-row--muted'}
            >
              <span className="edit-row__text">{row.category.name}</span>
              <Toggle
                small
                checked={row.visible}
                onChange={(visible) =>
                  setRows(rows.map((r, i) => (i === index ? { ...r, visible } : r)))
                }
                label={`Show ${row.category.name}`}
              />
            </ReorderRow>
          ))}
          <li className="edit-row edit-row--fixed">
            <span className="edit-row__handle edit-row__handle--disabled" aria-hidden="true" />
            <div className="edit-row__body">
              <span className="edit-row__text">
                Expert
                <span className="edit-row__sub">Always last</span>
              </span>
            </div>
          </li>
        </ul>

        <SheetFooter onCancel={onClose} isSaving={isSaving} />
      </form>
    </BottomSheet>
  );
}
