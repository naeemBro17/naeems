import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { useReorder } from '../../../hooks/useReorder';
import { normalizeText } from '../../../lib/format';
import {
  applyIdOrder,
  parseIdList,
  saveSettings,
  serializeIdList,
} from '../../../lib/settingsLists';
import { bentoTileToForm, emptyBentoTileForm } from '../../../lib/bentoTiles';
import { BottomSheet } from '../../shared/BottomSheet';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { AdminImagePicker } from '../AdminImagePicker';
import { BentoTileForm } from '../BentoTileForm';
import {
  CloseGlyph,
  PencilGlyph,
  ReorderRow,
  RowIconButton,
  SheetFooter,
  Toggle,
  TrashGlyph,
} from './SheetChrome';
import type { BentoTile, BentoTileFormData, Product } from '../../../types';

export type BentoEditTarget = 'left' | 'right-top' | 'bottom';

/** Same fixed path Admin → Settings → "Talk to an Expert" writes to, so both
 *  places edit the exact same stored photo instead of two separate files. */
const EXPERT_PHOTO_PATH = 'settings/expert-photo.webp';

interface BentoEditSheetProps {
  target: BentoEditTarget | null;
  onClose: () => void;
  /** Custom tiles currently loaded by the grid, and how to reload them. */
  tiles: BentoTile[];
  onTilesChanged: () => Promise<void>;
  /** The default product sequence each tile shows when no order is saved. */
  defaultLeft: Product[];
  defaultRightTop: Product[];
}

const TITLES: Record<BentoEditTarget, string> = {
  left: 'Featured Products — Left Tile',
  'right-top': 'Featured Products — Right Top Tile',
  bottom: 'Bottom Carousel',
};

/* ---------- Left / right-top: product sequence ---------- */

function ProductSequenceEditor({
  target,
  onClose,
  defaultSequence,
}: {
  target: 'left' | 'right-top';
  onClose: () => void;
  defaultSequence: Product[];
}) {
  const { products, settings, refetch } = useProducts();
  const { showToast } = useToast();

  const settingKey = target === 'left' ? 'bento_left_order' : 'bento_right_top_order';
  const featured = useMemo(
    () => products.filter((p) => p.is_featured && p.is_active),
    [products]
  );
  // The picker offers every active product, not just already-featured ones —
  // adding one here marks it featured on save (see handleSave) so it's not
  // possible to pick a product that then silently fails to appear in the
  // tile, which only ever renders from the featured list.
  const activeProducts = useMemo(() => products.filter((p) => p.is_active), [products]);

  const [sequence, setSequence] = useState<Product[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const saved = parseIdList(settings[settingKey]);
    setSequence(saved.length > 0 ? applyIdOrder(featured, saved, true) : defaultSequence);
    setIsAdding(false);
    setSearch('');
  }, [settings, settingKey, featured, defaultSequence]);

  const reorder = useReorder(sequence, setSequence);

  const inSequence = new Set(sequence.map((p) => p.id));
  const q = normalizeText(search.trim());
  const candidates = activeProducts.filter(
    (p) => !inSequence.has(p.id) && (q === '' || normalizeText(p.name).includes(q))
  );

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    // Every product in the sequence must be featured for the tile to
    // actually render it — flag any that were added straight from the
    // (unfeatured-included) picker before saving the order itself.
    const idsToFeature = sequence.filter((p) => !p.is_featured).map((p) => p.id);
    if (idsToFeature.length > 0) {
      const { error: featureError } = await supabase
        .from('products')
        .update({ is_featured: true })
        .in('id', idsToFeature);
      if (featureError) {
        console.error('Feature product save failed:', featureError);
        setIsSaving(false);
        showToast('Could not save the tile order', 'error');
        return;
      }
    }
    const error = await saveSettings({
      [settingKey]: serializeIdList(sequence.map((p) => p.id)),
    });
    if (error) {
      console.error('Bento order save failed:', error);
      setIsSaving(false);
      showToast('Could not save the tile order', 'error');
      return;
    }
    await refetch();
    setIsSaving(false);
    showToast('Saved');
    onClose();
  };

  return (
    <form className="form edit-sheet" onSubmit={handleSave} noValidate>
      <p className="edit-sheet__hint">
        {target === 'left'
          ? 'Slides in the order they appear when swiping up.'
          : 'The two faces of the auto-flip tile, front first.'}
      </p>

      {sequence.length === 0 ? (
        <p className="edit-sheet__empty">No products in this tile.</p>
      ) : (
        <ul className="edit-list">
          {sequence.map((product, index) => (
            <ReorderRow
              key={product.id}
              index={index}
              count={sequence.length}
              dragIndex={reorder.dragIndex}
              onDragStart={reorder.setDragIndex}
              onDragEnd={() => reorder.setDragIndex(null)}
              onDrop={reorder.dropOn}
              onMove={reorder.move}
              label={product.name}
            >
              <span className="edit-row__text">{product.name}</span>
              <RowIconButton
                label={`Remove ${product.name} from this tile`}
                variant="danger"
                onClick={() => setSequence(sequence.filter((p) => p.id !== product.id))}
              >
                <CloseGlyph />
              </RowIconButton>
            </ReorderRow>
          ))}
        </ul>
      )}

      {isAdding ? (
        <div className="edit-sheet__picker">
          <input
            type="search"
            className="form-input"
            placeholder="Search products…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search products"
          />
          <p className="form-helper">
            Adding a product here also marks it Featured so it shows in the tile.
          </p>
          {candidates.length === 0 ? (
            <p className="edit-sheet__empty">
              {activeProducts.length === sequence.length
                ? 'Every active product is already in this tile.'
                : 'No matches.'}
            </p>
          ) : (
            <ul className="edit-picker">
              {candidates.map((product) => (
                <li key={product.id}>
                  <button
                    type="button"
                    className="edit-picker__item"
                    onClick={() => {
                      setSequence([...sequence, product]);
                      setIsAdding(false);
                      setSearch('');
                    }}
                  >
                    {product.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="edit-sheet__cancel"
            onClick={() => setIsAdding(false)}
          >
            Done
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button button--secondary button--full"
          onClick={() => setIsAdding(true)}
        >
          + Add featured product
        </button>
      )}

      <SheetFooter onCancel={onClose} isSaving={isSaving} />
    </form>
  );
}

/* ---------- Bottom: expert card + custom tiles ---------- */

function BottomCarouselEditor({
  onClose,
  tiles,
  onTilesChanged,
}: {
  onClose: () => void;
  tiles: BentoTile[];
  onTilesChanged: () => Promise<void>;
}) {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [expertName, setExpertName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const [tileForm, setTileForm] = useState<BentoTileFormData | null>(null);
  const [editingTileId, setEditingTileId] = useState<string | null>(null);
  const [isSavingTile, setIsSavingTile] = useState(false);
  /** Ids with a row-level request (toggle/delete/reorder) in flight. */
  const [busy, setBusy] = useState(false);
  const [localTiles, setLocalTiles] = useState<BentoTile[]>(tiles);
  const [pendingDelete, setPendingDelete] = useState<BentoTile | null>(null);

  useEffect(() => {
    setExpertName(settings.expert_name);
    setSubtitle(settings.bento_expert_subtitle);
    setPhotoUrl(settings.expert_photo_url);
  }, [settings.expert_name, settings.bento_expert_subtitle, settings.expert_photo_url]);

  useEffect(() => {
    setLocalTiles(tiles);
  }, [tiles]);

  // Reordering writes every sort_order, then reloads — the visible order only
  // changes once the server has it.
  const persistOrder = async (next: BentoTile[]) => {
    setBusy(true);
    const results = await Promise.all(
      next.map((tile, index) =>
        supabase.from('bento_tiles').update({ sort_order: index + 1 }).eq('id', tile.id)
      )
    );
    if (results.some((r) => r.error)) {
      showToast('Could not save the tile order', 'error');
    } else {
      showToast('Saved');
    }
    await onTilesChanged();
    setBusy(false);
  };

  const reorder = useReorder(localTiles, (next) => void persistOrder(next));

  const patchTile = async (id: string, patch: Partial<BentoTile>) => {
    setBusy(true);
    const { error } = await supabase.from('bento_tiles').update(patch).eq('id', id);
    if (error) {
      console.error('Bento tile update failed:', error);
      showToast('Could not update the tile', 'error');
    } else {
      showToast('Saved');
    }
    await onTilesChanged();
    setBusy(false);
  };

  const deleteTile = async () => {
    if (!pendingDelete) return;
    const tile = pendingDelete;
    setPendingDelete(null);
    setBusy(true);
    const { error } = await supabase.from('bento_tiles').delete().eq('id', tile.id);
    if (error) {
      console.error('Bento tile delete failed:', error);
      showToast('Could not delete the tile', 'error');
    } else {
      showToast('Tile deleted');
    }
    await onTilesChanged();
    setBusy(false);
  };

  const submitTile = async (e: FormEvent) => {
    e.preventDefault();
    if (!tileForm) return;
    setIsSavingTile(true);
    const payload = {
      title: tileForm.title.trim(),
      subtitle: tileForm.subtitle.trim() === '' ? null : tileForm.subtitle.trim(),
      image_url: tileForm.image_url.trim() === '' ? null : tileForm.image_url.trim(),
      link_url: tileForm.link_url.trim(),
      sort_order: Number.parseInt(tileForm.sort_order, 10) || 0,
      is_active: tileForm.is_active,
    };
    const { error } = editingTileId
      ? await supabase.from('bento_tiles').update(payload).eq('id', editingTileId)
      : await supabase.from('bento_tiles').insert(payload);
    if (error) {
      console.error('Bento tile save failed:', error);
      setIsSavingTile(false);
      showToast('Could not save the tile', 'error');
      return;
    }
    await onTilesChanged();
    setIsSavingTile(false);
    showToast('Saved');
    setTileForm(null);
    setEditingTileId(null);
  };

  const handleSaveExpert = async (e: FormEvent) => {
    e.preventDefault();
    if (expertName.trim() === '') {
      showToast('Expert name is required', 'error');
      return;
    }
    setIsSaving(true);
    const error = await saveSettings({
      expert_name: expertName.trim(),
      bento_expert_subtitle: subtitle.trim(),
      expert_photo_url: photoUrl,
    });
    if (error) {
      console.error('Expert card save failed:', error);
      setIsSaving(false);
      showToast('Could not save the expert card', 'error');
      return;
    }
    await refetch();
    setIsSaving(false);
    showToast('Saved');
    onClose();
  };

  if (tileForm !== null) {
    return (
      <div className="edit-sheet">
        <BentoTileForm
          form={tileForm}
          title={editingTileId ? 'Edit Tile' : 'New Tile'}
          isSaving={isSavingTile}
          onChange={(patch) =>
            setTileForm((current) => (current ? { ...current, ...patch } : current))
          }
          onSubmit={submitTile}
          onCancel={() => {
            setTileForm(null);
            setEditingTileId(null);
          }}
        />
      </div>
    );
  }

  return (
    <form className="form edit-sheet" onSubmit={handleSaveExpert} noValidate>
      <h3 className="edit-sheet__subtitle">Expert card</h3>
      <p className="edit-sheet__hint">Always the first card. Opens the /contact page.</p>

      <div className="form-field">
        <span className="form-label">Photo</span>
        <AdminImagePicker
          path={EXPERT_PHOTO_PATH}
          value={photoUrl || null}
          onChange={(url) => setPhotoUrl(url ?? '')}
          shape="circle"
          label="Talk with Naeem photo"
          placeholderIcon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" />
            </svg>
          }
        />
        <p className="form-helper">
          Same photo as Admin → Settings → "Talk to an Expert".
        </p>
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="be-name">
          Expert name <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="be-name"
          type="text"
          className="form-input"
          value={expertName}
          onChange={(e) => setExpertName(e.target.value)}
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="be-subtitle">Subtitle</label>
        <input
          id="be-subtitle"
          type="text"
          className="form-input"
          placeholder="Skincare Expert"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
        />
      </div>

      <div className="form-field">
        <span className="form-label">Link</span>
        <p className="form-readonly">/contact</p>
      </div>

      <h3 className="edit-sheet__subtitle">Custom link tiles</h3>
      <p className="edit-sheet__hint">
        Each change here saves straight away.{busy ? ' Saving…' : ''}
      </p>

      {localTiles.length === 0 ? (
        <p className="edit-sheet__empty">No custom tiles yet.</p>
      ) : (
        <ul className={`edit-list${busy ? ' edit-list--busy' : ''}`}>
          {localTiles.map((tile, index) => (
            <ReorderRow
              key={tile.id}
              index={index}
              count={localTiles.length}
              dragIndex={reorder.dragIndex}
              onDragStart={reorder.setDragIndex}
              onDragEnd={() => reorder.setDragIndex(null)}
              onDrop={reorder.dropOn}
              onMove={reorder.move}
              label={tile.title}
              className={tile.is_active ? undefined : 'edit-row--muted'}
            >
              <span className="edit-row__text">
                {tile.title}
                <span className="edit-row__sub">{tile.link_url}</span>
              </span>
              <Toggle
                small
                checked={tile.is_active}
                onChange={(is_active) => void patchTile(tile.id, { is_active })}
                label={`${tile.title} active`}
              />
              <RowIconButton
                label={`Edit ${tile.title}`}
                onClick={() => {
                  setTileForm(bentoTileToForm(tile));
                  setEditingTileId(tile.id);
                }}
              >
                <PencilGlyph />
              </RowIconButton>
              <RowIconButton
                label={`Delete ${tile.title}`}
                variant="danger"
                onClick={() => setPendingDelete(tile)}
              >
                <TrashGlyph />
              </RowIconButton>
            </ReorderRow>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="button button--secondary button--full"
        onClick={() => {
          setTileForm({ ...emptyBentoTileForm(), sort_order: String(localTiles.length + 1) });
          setEditingTileId(null);
        }}
      >
        + Add Tile
      </button>

      <SheetFooter onCancel={onClose} isSaving={isSaving} saveLabel="Save expert card" />

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Delete tile?"
        message={pendingDelete ? `"${pendingDelete.title}" will be permanently removed.` : ''}
        confirmLabel="Delete"
        onConfirm={deleteTile}
        onClose={() => setPendingDelete(null)}
      />
    </form>
  );
}

/**
 * One sheet for all three bento tiles; `target` picks which editor renders.
 * The product-sequence editors save a single app_settings row; the bottom
 * carousel editor saves the expert card to app_settings and manages the
 * bento_tiles table row by row.
 */
export function BentoEditSheet({
  target,
  onClose,
  tiles,
  onTilesChanged,
  defaultLeft,
  defaultRightTop,
}: BentoEditSheetProps) {
  return (
    <BottomSheet
      isOpen={target !== null}
      onClose={onClose}
      title={target ? TITLES[target] : 'Bento'}
    >
      {target === 'left' && (
        <ProductSequenceEditor target="left" onClose={onClose} defaultSequence={defaultLeft} />
      )}
      {target === 'right-top' && (
        <ProductSequenceEditor
          target="right-top"
          onClose={onClose}
          defaultSequence={defaultRightTop}
        />
      )}
      {target === 'bottom' && (
        <BottomCarouselEditor onClose={onClose} tiles={tiles} onTilesChanged={onTilesChanged} />
      )}
    </BottomSheet>
  );
}
