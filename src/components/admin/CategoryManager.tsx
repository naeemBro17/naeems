import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { slugify } from '../../lib/format';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import type { Category } from '../../types';

export function CategoryManager() {
  const { categories, products, refetch } = useProducts();
  const { showToast } = useToast();

  const [newName, setNewName] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);

  const productCountByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products) {
      if (product.category_id !== null) {
        counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [products]);

  const handleAdd = async () => {
    const name = newName.trim();
    if (name === '') return;
    setIsAdding(true);
    const { error } = await supabase
      .from('categories')
      .insert({ name, slug: slugify(name) });
    setIsAdding(false);
    if (error) {
      showToast('Could not create category — the name may already exist', 'error');
      return;
    }
    setNewName('');
    await refetch();
    showToast(`Category '${name}' created`);
  };

  const startEdit = (category: Category) => {
    setEditingId(category.id);
    setEditingName(category.name);
  };

  const handleSaveEdit = async (category: Category) => {
    const name = editingName.trim();
    if (name === '') return;
    setIsSavingEdit(true);
    const { error } = await supabase
      .from('categories')
      .update({ name, slug: slugify(name) })
      .eq('id', category.id);
    setIsSavingEdit(false);
    if (error) {
      showToast('Could not rename category — the name may already exist', 'error');
      return;
    }
    setEditingId(null);
    await refetch();
    showToast('Category updated');
  };

  const handleDelete = async () => {
    if (!deletingCategory) return;
    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', deletingCategory.id);
    if (error) {
      showToast('Could not delete the category. Please try again.', 'error');
      return;
    }
    setDeletingCategory(null);
    await refetch();
    showToast('Category deleted');
  };

  const deletingCount = deletingCategory
    ? productCountByCategory.get(deletingCategory.id) ?? 0
    : 0;

  return (
    <section aria-label="Categories">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Categories</h2>
      </header>

      <div className="category-add-form">
        <div className="category-add-form__inputs">
          <input
            type="text"
            className="form-input"
            placeholder="New category name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New category name"
          />
          {newName.trim() !== '' && (
            <p className="form-helper">
              Slug: <code>{slugify(newName)}</code>
            </p>
          )}
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={handleAdd}
          disabled={isAdding || newName.trim() === ''}
        >
          {isAdding ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </div>

      {categories.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__message">No categories yet</p>
        </div>
      ) : (
        <ul className="admin-category-list">
          {categories.map((category) => {
            const count = productCountByCategory.get(category.id) ?? 0;
            const isEditing = editingId === category.id;
            return (
              <li key={category.id} className="admin-category-row">
                {isEditing ? (
                  <div className="admin-category-row__edit">
                    <input
                      type="text"
                      className="form-input"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      aria-label={`Rename category ${category.name}`}
                    />
                    <button
                      type="button"
                      className="button button--primary button--small"
                      onClick={() => handleSaveEdit(category)}
                      disabled={isSavingEdit || editingName.trim() === ''}
                    >
                      {isSavingEdit ? <span className="spinner" aria-hidden="true" /> : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="admin-category-row__info">
                      <p className="admin-category-row__name">{category.name}</p>
                      <p className="admin-category-row__slug">{category.slug}</p>
                    </div>
                    <span className="count-badge">
                      {count} {count === 1 ? 'product' : 'products'}
                    </span>
                    <div className="admin-category-row__actions">
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        onClick={() => startEdit(category)}
                        aria-label={`Edit ${category.name}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button--danger-outline button--small"
                        onClick={() => setDeletingCategory(category)}
                        aria-label={`Delete ${category.name}`}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        isOpen={deletingCategory !== null}
        title="Delete Category"
        message={
          deletingCategory
            ? deletingCount > 0
              ? `This category has ${deletingCount} product(s). Remove or reassign them first.`
              : `Delete '${deletingCategory.name}'? This cannot be undone.`
            : ''
        }
        confirmLabel={deletingCount > 0 ? null : 'Delete'}
        cancelLabel={deletingCount > 0 ? 'Close' : 'Cancel'}
        onConfirm={handleDelete}
        onClose={() => setDeletingCategory(null)}
      />
    </section>
  );
}
