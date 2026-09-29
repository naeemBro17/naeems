import type { VariantOption } from '../../types';
import { regionsOf, variantOptionLabel } from '../../lib/variants';

/* Shared by the product page and the card's quick-add sheet (Batch 23
   Parts 3-4), so both pick options by exactly the same rules. */

/** One row of pill chips — a Region row, a Size row, or (for the flat
 *  fallback) a row of full option labels. */
function ChipRow({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="variant-row" role="group" aria-label={label}>
      <span className="variant-row__label">{label}</span>
      <div className="variant-row__chips">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`chip-select${option === selected ? ' chip-select--on' : ''}`}
            aria-pressed={option === selected}
            onClick={() => onSelect(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Flat single row, one chip per option, each showing its own full label —
 *  the fallback for a product whose options don't cleanly split into a
 *  Region×Size matrix (see VariantSelector's doc comment). */
function FlatOptionRow({
  options,
  productName,
  selected,
  onSelect,
}: {
  options: VariantOption[];
  productName: string;
  selected: VariantOption;
  onSelect: (option: VariantOption) => void;
}) {
  return (
    <div className="variant-selector">
      <div className="variant-row" role="group" aria-label="Choose an option">
        <div className="variant-row__chips">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`chip-select${option.id === selected.id ? ' chip-select--on' : ''}`}
              aria-pressed={option.id === selected.id}
              onClick={() => onSelect(option)}
            >
              {variantOptionLabel(option, productName)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Option picker, rendered only when a product has 2+ selectable options (its
 * own base entry plus one or more real variant rows — see variantOptionsFor).
 *
 * Two-level by default — a Region row, then a Size row filtered to whatever
 * that region actually has — because that's what reads best for the common
 * case where every option cleanly carries both. Falls back to one flat row
 * of full labels only when it can't: an option with a blank Region or Size
 * (a product with no label at all, showing its bare name as the fallback
 * option — see variantOptionLabel — or an option built by the "combine
 * products into variants" flow that was only given one half of a label)
 * can't be placed in a region×size grid at all, so the whole selector drops
 * to the flat list rather than showing a broken or misleading grid.
 */
export function VariantSelector({
  options,
  productName,
  selected,
  onSelect,
}: {
  options: VariantOption[];
  productName: string;
  selected: VariantOption;
  onSelect: (option: VariantOption) => void;
}) {
  const canGroup = options.every((o) => o.region.trim() !== '' && o.size.trim() !== '');

  if (!canGroup) {
    return (
      <FlatOptionRow
        options={options}
        productName={productName}
        selected={selected}
        onSelect={onSelect}
      />
    );
  }

  const regions = regionsOf(options);
  const optionsInRegion = options.filter((o) => o.region === selected.region);
  const sizesInRegion = Array.from(new Set(optionsInRegion.map((o) => o.size)));

  const pickRegion = (region: string) => {
    // Keep the same size selected across the region switch when that size
    // exists there too; otherwise fall back to the first option in it.
    const sameSize = options.find((o) => o.region === region && o.size === selected.size);
    const first = sameSize ?? options.find((o) => o.region === region);
    if (first) onSelect(first);
  };

  const pickSize = (size: string) => {
    const match = optionsInRegion.find((o) => o.size === size);
    if (match) onSelect(match);
  };

  return (
    <div className="variant-selector">
      {regions.length > 1 && (
        <ChipRow label="Region" options={regions} selected={selected.region} onSelect={pickRegion} />
      )}
      {/* With a Region row, the Size row always follows — even a region with
          just one size shows it, pre-selected, so the shopper always sees
          what size they are buying (Batch 23 Part 3). */}
      {(regions.length > 1 || sizesInRegion.length > 1) && (
        <ChipRow label="Size" options={sizesInRegion} selected={selected.size} onSelect={pickSize} />
      )}
    </div>
  );
}

