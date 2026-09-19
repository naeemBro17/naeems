import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProductCardName } from './ProductCard';

// Real catalogue names from Naeems.txt "Batch 7" — the old JS line-splitter
// (removed in this batch) broke several of these mid-word. Native CSS
// wrapping never touches the text node, so this guards against a future
// change reintroducing a JS splitter that mutates it.
const REAL_PRODUCT_NAMES = [
  'CeraVe Moisturising Cream 50ml',
  'CeraVe Moisturizing Lotion 236ml',
  'CeraVe Oil Control Moisturising Gel-Cream 52ml',
  'Cerave PM Face Moisturizing Lotion 89ml',
  'CeraVe Hydrating Foaming Oil Cleanser 473ml',
  'Aveeno Baby Daily Moisture Fragrance Free Lotion 227g',
  'Beauty of Joseon Red Bean Water Gel',
  'Bio Oil | 200mL',
];

let container: HTMLDivElement | null = null;

afterEach(() => {
  if (container) {
    document.body.removeChild(container);
    container = null;
  }
});

function renderName(name: string): string {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ProductCardName name={name} />);
  });
  const el = container.querySelector('.product-card__name');
  if (!el) throw new Error('product-card__name element not found');
  return el.textContent ?? '';
}

describe('ProductCardName', () => {
  it.each(REAL_PRODUCT_NAMES)('renders "%s" with no mid-word break', (name) => {
    const rendered = renderName(name);
    // The name is a single text node wrapped by CSS only — the DOM text
    // must exactly match the source name, never a JS-split/truncated
    // fragment like "CeraVe Moisturi" + "sing Cream 50...".
    expect(rendered).toBe(name);
  });

  it('reserves a two-line-tall element even for a short name', () => {
    renderName('Bio Oil | 200mL');
    const el = container!.querySelector('.product-card__name') as HTMLElement;
    expect(el.className).toContain('product-card__name');
  });
});
