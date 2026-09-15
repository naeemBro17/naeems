import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { BENTO_TILE_SELECT, bentoTileToForm, emptyBentoTileForm } from '../../lib/bentoTiles';
import { useToast } from '../../hooks/useToast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { BentoTileForm } from './BentoTileForm';
import type { BentoTile, BentoTileFormData } from '../../types';

export function BentoTilesTab() {
  const { showToast } = useToast();

  const [tiles, setTiles] = useState<BentoTile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState<BentoTileFormData | null>(null);
  /** Row being edited, or null when the form is creating a new tile. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BentoTile | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('bento_tiles')
      .select(BENTO_TILE_SELECT)
      .order('sort_order', { ascending: true });
    setIsLoading(false);
    if (error) {
      console.error('Bento tile load failed:', error);
      showToast('Could not load bento tiles', 'error');
      return;
    }
    setTiles((data ?? []) as BentoTile[]);
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchRow = async (id: string, patch: Partial<BentoTile>) => {
    const { error } = await supabase.from('bento_tiles').update(patch).eq('id', id);
    if (error) {
      console.error('Bento tile update failed:', error);
      showToast('Could not update the tile', 'error');
      return;
    }
    await load();
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const { error } = await supabase
      .from('bento_tiles')
      .delete()
      .eq('id', pendingDelete.id);
    setPendingDelete(null);
    if (error) {
      console.error('Bento tile delete failed:', error);
      showToast('Could not delete the tile', 'error');
      return;
    }
    showToast('Tile deleted');
    await load();
  };

  /** Reorder and write every new sort_order in one pass. */
  const handleDrop = async (targetId: string) => {
    if (dragId === null || dragId === targetId) {
      setDragId(null);
      return;
    }
    const from = tiles.findIndex((t) => t.id === dragId);
    const to = tiles.findIndex((t) => t.id === targetId);
    setDragId(null);
    if (from === -1 || to === -1) return;

    const next = [...tiles];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);

    setTiles(next);
    const results = await Promise.all(
      next.map((tile, index) =>
        supabase.from('bento_tiles').update({ sort_order: index + 1 }).eq('id', tile.id)
      )
    );
    if (results.some((r) => r.error)) {
      showToast('Could not save the new order', 'error');
    }
    await load();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setIsSaving(true);
    const payload = {
      title: form.title.trim(),
      subtitle: form.subtitle.trim() === '' ? null : form.subtitle.trim(),
      image_url: form.image_url.trim() === '' ? null : form.image_url.trim(),
      link_url: form.link_url.trim(),
      sort_order: Number.parseInt(form.sort_order, 10) || 0,
      is_active: form.is_active,
    };

    const { error } = editingId
      ? await supabase.from('bento_tiles').update(payload).eq('id', editingId)
      : await supabase.from('bento_tiles').insert(payload);
    setIsSaving(false);

    if (error) {
      console.error('Bento tile save failed:', error);
      showToast('Could not save the tile', 'error');
      return;
    }
    showToast(editingId ? 'Tile updated' : 'Tile added');
    setForm(null);
    setEditingId(null);
    await load();
  };

  const startCreate = () => {
    setForm({ ...emptyBentoTileForm(), sort_order: String(tiles.length + 1) });
    setEditingId(null);
  };

  return (
    <section aria-label="Bento tiles">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Bento Tiles</h2>
        {form === null && (
          <button type="button" className="button button--primary" onClick={startCreate}>
            Add Tile
          </button>
        )}
      </header>

      {form !== null && (
        <div className="admin-panel">
          <BentoTileForm
            form={form}
            title={editingId ? 'Edit Tile' : 'New Tile'}
            isSaving={isSaving}
            onChange={(patch) =>
              setForm((current) => (current ? { ...current, ...patch } : current))
            }
            onSubmit={handleSubmit}
            onCancel={() => {
              setForm(null);
              setEditingId(null);
            }}
          />
        </div>
      )}

      <div className="admin-panel">
        <h3 className="admin-panel__title">Homepage Carousel</h3>
        <p className="admin-panel__description">
          These cards sit beside the "Talk with" expert card in the bottom-right
          bento tile, which always comes first. Drag the handle to reorder.
        </p>

        {isLoading ? (
          <div className="full-screen-center">
            <span className="spinner spinner--large" aria-hidden="true" />
          </div>
        ) : tiles.length === 0 ? (
          <p className="review-admin__empty">
            No custom tiles yet — the carousel shows only the expert card.
          </p>
        ) : (
          <ul className="review-admin__list">
            {tiles.map((tile) => (
              <li
                key={tile.id}
                className={`review-admin__row${
                  dragId === tile.id ? ' review-admin__row--dragging' : ''
                }`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => void handleDrop(tile.id)}
              >
                <span
                  className="review-admin__handle"
                  draggable
                  onDragStart={() => setDragId(tile.id)}
                  onDragEnd={() => setDragId(null)}
                  aria-label={`Reorder ${tile.title}`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
                  </svg>
                </span>

                <div className="review-admin__info">
                  <span className="review-admin__name">
                    {tile.title}
                    {!tile.is_active && (
                      <span className="status-badge status-badge--inactive">Inactive</span>
                    )}
                  </span>
                  {tile.subtitle && (
                    <span className="review-admin__quote">{tile.subtitle}</span>
                  )}
                  <span className="review-admin__country">{tile.link_url}</span>
                </div>

                <div className="review-admin__actions">
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => void patchRow(tile.id, { is_active: !tile.is_active })}
                  >
                    {tile.is_active ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => {
                      setForm(bentoTileToForm(tile));
                      setEditingId(tile.id);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="button button--danger-outline button--small"
                    onClick={() => setPendingDelete(tile)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Delete tile?"
        message={
          pendingDelete ? `"${pendingDelete.title}" will be permanently removed.` : ''
        }
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onClose={() => setPendingDelete(null)}
      />
    </section>
  );
}
