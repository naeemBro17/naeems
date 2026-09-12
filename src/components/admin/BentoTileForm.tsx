import type { FormEvent } from 'react';
import { isInternalLink } from '../../lib/bentoTiles';
import type { BentoTileFormData } from '../../types';

interface TileFormProps {
  form: BentoTileFormData;
  title: string;
  isSaving: boolean;
  onChange: (patch: Partial<BentoTileFormData>) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}

export function BentoTileForm({ form, title, isSaving, onChange, onSubmit, onCancel }: TileFormProps) {
  return (
    <form onSubmit={onSubmit} className="form review-admin__form" noValidate>
      <h4 className="review-admin__form-title">{title}</h4>

      <div className="form-field">
        <label className="form-label" htmlFor="bento-title">
          Title <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="bento-title"
          type="text"
          className="form-input"
          placeholder="Health Lab"
          value={form.title}
          onChange={(e) => onChange({ title: e.target.value })}
          required
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="bento-subtitle">
          Subtitle
        </label>
        <input
          id="bento-subtitle"
          type="text"
          className="form-input"
          placeholder="Track your skin routine"
          value={form.subtitle}
          onChange={(e) => onChange({ subtitle: e.target.value })}
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="bento-image">
          Image URL
        </label>
        <input
          id="bento-image"
          type="url"
          className="form-input"
          placeholder="https://…"
          value={form.image_url}
          onChange={(e) => onChange({ image_url: e.target.value })}
        />
        <p className="form-helper">
          Optional background image. A neutral card is used when blank.
        </p>
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="bento-link">
          Link URL <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="bento-link"
          type="text"
          className="form-input"
          placeholder="/health-lab or https://…"
          value={form.link_url}
          onChange={(e) => onChange({ link_url: e.target.value })}
          required
        />
        <p className="form-helper">
          {form.link_url.trim() !== '' && isInternalLink(form.link_url.trim())
            ? 'Starts with "/" — opens inside the app.'
            : 'Opens in a new tab. Start with "/" for a page inside the app.'}
        </p>
      </div>

      <div className="form-field form-field--toggle">
        <span className="toggle-label">Active (shown on the homepage)</span>
        <button
          type="button"
          className={`toggle${form.is_active ? ' toggle--on' : ''}`}
          onClick={() => onChange({ is_active: !form.is_active })}
          role="switch"
          aria-checked={form.is_active}
          aria-label="Active"
        >
          <span className="toggle__thumb" />
        </button>
      </div>

      <div className="review-admin__form-actions">
        <button
          type="submit"
          className="button button--primary"
          disabled={isSaving || form.title.trim() === '' || form.link_url.trim() === ''}
        >
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save Tile'}
        </button>
        <button type="button" className="button button--secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
