import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Category, Product } from '../../types';
import { normalizeText } from '../../lib/format';
import { applyIdOrder, parseIdList } from '../../lib/settingsLists';
import { useProducts } from '../../contexts/ProductContext';
import { useAdminEdit } from '../../contexts/AdminEditContext';
import { EditButton } from '../admin/EditButton';
import { BrowseEditSheet } from '../admin/edit-sheets/BrowseEditSheet';

interface BrowseCirclesProps {
  categories: Category[];
  products: Product[];
  selectedId: string | null;
  /** Applies the category filter and scrolls down to the All Products grid. */
  onSelect: (id: string | null) => void;
}

const NEW_WINDOW_DAYS = 30;
const NEW_WINDOW_MS = NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const ICON_PROPS = {
  viewBox: '0 0 32 32',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Face outline with a smile — the catalog's broadest skincare group. */
function FaceCareIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M16 4.5c-5 0-8.5 3.4-8.5 8v3.8c0 5 3.8 9.2 8.5 9.2s8.5-4.2 8.5-9.2V12.5c0-4.6-3.5-8-8.5-8z" />
      <path d="M12.4 14.5h.02M19.6 14.5h.02" />
      <path d="M12.9 19.2c1.9 1.5 4.3 1.5 6.2 0" />
    </svg>
  );
}

/** Pump bottle with an angled nozzle — body lotion. */
function BodyCareIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M17 4.5h3.5" />
      <path d="M17 4.5v3" />
      <path d="M14.5 7.5h5v3h-5z" />
      <path d="M11 14a3.5 3.5 0 013.5-3.5h5A3.5 3.5 0 0123 14v9.5a3.5 3.5 0 01-3.5 3.5h-5A3.5 3.5 0 0111 23.5V14z" />
    </svg>
  );
}

/** Wide-tooth comb. */
function HairCareIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M6.5 8.5h19a1 1 0 011 1v2.5h-21V9.5a1 1 0 011-1z" />
      <path d="M10 12v10M14 12v10M18 12v10M22 12v10" />
    </svg>
  );
}

/** Sunscreen tube carrying a sun mark on its label. */
function SunBlockIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <rect x="13" y="4.5" width="6" height="3.5" rx="1" />
      <path d="M11.5 12a3.5 3.5 0 013.5-3.5h2a3.5 3.5 0 013.5 3.5v13.5h-9V12z" />
      <path d="M11.5 25.5h9" />
      <circle cx="16" cy="17.4" r="2.1" />
      <path d="M16 13.6v.8M16 20.4v.8M12.9 17.4h.8M19.3 17.4h.8" />
    </svg>
  );
}

/** Lip balm stick. */
function LipCareIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <rect x="12" y="4.5" width="8" height="5.5" rx="1" />
      <path d="M11.5 10h9v14.5a2.5 2.5 0 01-2.5 2.5h-4a2.5 2.5 0 01-2.5-2.5V10z" />
      <path d="M11.5 14.5h9" />
    </svg>
  );
}

/** Eye with an iris. */
function EyeCareIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M3.5 16s4.6-7 12.5-7 12.5 7 12.5 7-4.6 7-12.5 7S3.5 16 3.5 16z" />
      <circle cx="16" cy="16" r="3.6" />
    </svg>
  );
}

/** Toothbrush — free bristle strokes above the head so it reads at 30px. */
function OralHygieneIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M13.4 6.2v3.3M15.1 5.2v4.3M16.9 5.2v4.3M18.6 6.2v3.3" />
      <path d="M12.8 9.5h6.4v2.6h-6.4z" />
      <path d="M14.4 12.1h3.2v12.6a1.6 1.6 0 01-3.2 0V12.1z" />
    </svg>
  );
}

/** Baby feeding bottle with a teat and a measure line. */
function BabyCareIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M14.2 4.5h3.6v3h-3.6z" />
      <path d="M12.5 9h7" />
      <path d="M12.5 11h7v12.5a3.5 3.5 0 01-3.5 3.5 3.5 3.5 0 01-3.5-3.5V11z" />
      <path d="M12.5 16h3.5" />
    </svg>
  );
}

/** Divided capsule. */
function SupplementsIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <rect x="5" y="12" width="22" height="8" rx="4" />
      <path d="M16 12v8" />
    </svg>
  );
}

/** Perfume flacon with an atomiser arm. */
function PerfumeIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M20.5 6.5h3.5v3" />
      <rect x="13" y="4.5" width="6" height="4" rx="1" />
      <path d="M10.5 13a4.5 4.5 0 014.5-4.5h2a4.5 4.5 0 014.5 4.5v9.5a4.5 4.5 0 01-4.5 4.5h-2a4.5 4.5 0 01-4.5-4.5V13z" />
    </svg>
  );
}

/** Jar with a separate lid — moisturiser. */
function MoisturiserIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <rect x="7" y="11" width="18" height="4" rx="1.5" />
      <path d="M8.5 15h15v9a3 3 0 01-3 3h-9a3 3 0 01-3-3v-9z" />
      <path d="M12 8.5h8" />
    </svg>
  );
}

/** Dropper bottle — bulb, pipette collar, body. */
function SerumIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M13 4.5h6v3.5h-6z" />
      <path d="M14 8h4v2.5h-4z" />
      <path d="M11.5 14a3.5 3.5 0 013.5-3.5h2a3.5 3.5 0 013.5 3.5v9a4 4 0 01-4 4h-1a4 4 0 01-4-4v-9z" />
      <path d="M16 16v4" />
    </svg>
  );
}

/** Slim tall bottle with a narrow neck — toner. */
function TonerIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M14 4.5h4v4h-4z" />
      <path d="M12.5 12a3.5 3.5 0 013.5-3.5h0a3.5 3.5 0 013.5 3.5v11.5a3.5 3.5 0 01-3.5 3.5h0a3.5 3.5 0 01-3.5-3.5V12z" />
      <path d="M12.5 17.5h7" />
    </svg>
  );
}

/** Head and shoulders silhouette. */
function ExpertIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <circle cx="16" cy="11" r="4.5" />
      <path d="M7.5 26.5v-1.5a6 6 0 016-6h5a6 6 0 016 6v1.5" />
    </svg>
  );
}

/** Neutral tag, used for any category without a dedicated icon. */
function GenericIcon() {
  return (
    <svg className="browse-circle__icon" {...ICON_PROPS}>
      <path d="M16.5 5.5H26v9.5L15 26 6 17l10.5-11.5z" />
      <circle cx="21" cy="11" r="1.6" />
    </svg>
  );
}

/**
 * Curated categories in the order they appear in the row. Each is matched to a
 * database category by name, so alternate spellings and the product-type names
 * a store might use instead ("Sunscreen" for "Sun Block") both resolve to the
 * right icon. Categories with no entry here fall back to GenericIcon.
 */
const CURATED: { aliases: string[]; icon: () => JSX.Element }[] = [
  { aliases: ['face care', 'facecare', 'face'], icon: FaceCareIcon },
  { aliases: ['moisturiser', 'moisturizer'], icon: MoisturiserIcon },
  { aliases: ['serum', 'serums'], icon: SerumIcon },
  { aliases: ['cleanser', 'cleansers', 'face wash'], icon: BodyCareIcon },
  { aliases: ['toner', 'toners'], icon: TonerIcon },
  { aliases: ['body care', 'bodycare', 'body'], icon: BodyCareIcon },
  { aliases: ['hair care', 'haircare', 'hair'], icon: HairCareIcon },
  { aliases: ['sun block', 'sunblock', 'sunscreen', 'sun screen', 'spf'], icon: SunBlockIcon },
  { aliases: ['lip care', 'lipcare', 'lips'], icon: LipCareIcon },
  { aliases: ['eye care', 'eyecare', 'eyes'], icon: EyeCareIcon },
  { aliases: ['oral hygiene', 'oral care', 'oral'], icon: OralHygieneIcon },
  { aliases: ['baby care', 'babycare', 'baby'], icon: BabyCareIcon },
  { aliases: ['supplements', 'supplement', 'vitamins'], icon: SupplementsIcon },
  { aliases: ['perfume', 'perfumes', 'fragrance'], icon: PerfumeIcon },
];

interface CircleEntry {
  key: string;
  label: string;
  categoryId: string;
  icon: () => JSX.Element;
  /** Admin-uploaded photo for this category; null shows the icon instead. */
  imageUrl: string | null;
  isHot: boolean;
  isNew: boolean;
}

export function BrowseCircles({
  categories,
  products,
  selectedId,
  onSelect,
}: BrowseCirclesProps) {
  const navigate = useNavigate();
  const { settings } = useProducts();
  const { isEditMode } = useAdminEdit();
  const [editorOpen, setEditorOpen] = useState(false);

  // Saved visibility/order from Edit Mode. Empty → the curated default.
  const savedOrder = useMemo(
    () => parseIdList(settings.browse_categories_order),
    [settings.browse_categories_order]
  );

  const entries = useMemo<CircleEntry[]>(() => {
    const featuredCategoryIds = new Set<string>();
    const freshCategoryIds = new Set<string>();
    const newestCutoff = Date.now() - NEW_WINDOW_MS;

    for (const product of products) {
      if (product.category_id === null) continue;
      if (product.is_featured) featuredCategoryIds.add(product.category_id);
      if (Date.parse(product.created_at) >= newestCutoff) {
        freshCategoryIds.add(product.category_id);
      }
    }

    const byName = new Map(categories.map((c) => [normalizeText(c.name).trim(), c]));
    const used = new Set<string>();
    const ordered: CircleEntry[] = [];

    const push = (category: Category, icon: () => JSX.Element) => {
      used.add(category.id);
      ordered.push({
        key: category.id,
        label: category.name,
        categoryId: category.id,
        icon,
        imageUrl: category.image_url,
        isHot: featuredCategoryIds.has(category.id),
        isNew: freshCategoryIds.has(category.id),
      });
    };

    const iconFor = (category: Category) => {
      const name = normalizeText(category.name).trim();
      return CURATED.find((c) => c.aliases.includes(name))?.icon ?? GenericIcon;
    };

    if (savedOrder.length > 0) {
      // The admin chose which circles show and in what order.
      for (const category of applyIdOrder(categories, savedOrder, true)) {
        push(category, iconFor(category));
      }
      return ordered;
    }

    // Curated first, in the specified order, skipping any this store
    // doesn't stock.
    for (const { aliases, icon } of CURATED) {
      const match = aliases.map((a) => byName.get(a)).find((c) => c !== undefined);
      if (match && !used.has(match.id)) push(match, icon);
    }
    // Then every remaining category, so nothing in the catalog is unreachable.
    for (const category of categories) {
      if (!used.has(category.id)) push(category, GenericIcon);
    }

    return ordered;
  }, [categories, products, savedOrder]);

  const displayed = useMemo(
    () =>
      entries
        .map((e) => categories.find((c) => c.id === e.categoryId))
        .filter((c): c is Category => c !== undefined),
    [entries, categories]
  );

  if (entries.length === 0 && !isEditMode) return null;

  return (
    <section className="browse" aria-label="Browse by category">
      <div className="browse__head">
        <h2 className="browse__title">Browse</h2>
        <EditButton
          label="Edit Browse categories"
          className="edit-btn--inline"
          onClick={() => setEditorOpen(true)}
        />
      </div>
      <div className="browse__row">
        {entries.map((entry) => {
          const Icon = entry.icon;
          const isSelected = selectedId === entry.categoryId;
          return (
            <button
              key={entry.key}
              type="button"
              className="browse-item"
              onClick={() => onSelect(isSelected ? null : entry.categoryId)}
              aria-pressed={isSelected}
              aria-label={`Show ${entry.label} products`}
            >
              <span
                className={`browse-circle${entry.isHot ? ' browse-circle--hot' : ''}${
                  isSelected ? ' browse-circle--selected' : ''
                }`}
              >
                {entry.imageUrl ? (
                  <img className="browse-circle__image" src={entry.imageUrl} alt="" />
                ) : (
                  <Icon />
                )}
                {entry.isNew && (
                  <span className="browse-circle__badge" aria-hidden="true">
                    NEW
                  </span>
                )}
              </span>
              <span className="browse-item__label">{entry.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          className="browse-item"
          onClick={() => navigate('/contact')}
          aria-label="Talk to a skincare expert"
        >
          <span className="browse-circle browse-circle--expert">
            <ExpertIcon />
          </span>
          <span className="browse-item__label">Expert</span>
        </button>
      </div>

      <BrowseEditSheet
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        displayed={displayed}
      />
    </section>
  );
}
