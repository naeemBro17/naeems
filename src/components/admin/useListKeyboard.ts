import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react';

/**
 * Batch 64 Part 6a: arrow keys and Enter in a search box's floating result
 * list (Admin → New order, Edit order). Arrow Down / Up move a highlight
 * (stopping at the first and last row), Enter picks the highlighted row,
 * typing puts the highlight back on the first row. The box is a combobox
 * and the list a listbox, so a screen reader follows the highlight.
 * Taps and clicks are not touched: rows stay ordinary buttons.
 */
export interface ListKeyboard {
  listId: string;
  /** The highlighted row, or -1 when the list is empty. */
  active: number;
  optionId: (index: number) => string;
  /** For the search input: the combobox attributes and the keys. */
  inputProps: {
    role: 'combobox';
    'aria-expanded': boolean;
    'aria-controls': string;
    'aria-autocomplete': 'list';
    'aria-activedescendant': string | undefined;
    onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  };
  /** Call when the text changes. */
  reset: () => void;
  /** A list that picks rows itself (ProductResults) puts its pick here. */
  pickRef: MutableRefObject<((index: number) => void) | null>;
}

export function useListKeyboard(count: number, open: boolean, onPick?: (index: number) => void): ListKeyboard {
  const listId = `lk${useId().replace(/:/g, '')}`;
  const [activeRaw, setActive] = useState(0);
  const pickRef = useRef<((index: number) => void) | null>(null);
  const movedByKey = useRef(false);
  const shown = open && count > 0;
  const active = shown ? Math.min(activeRaw, count - 1) : -1;
  const optionId = (index: number) => `${listId}-o${index}`;

  // Only a key press scrolls the highlighted row into view (never a list
  // simply opening, which on a phone could move the page).
  useEffect(() => {
    if (!movedByKey.current || active < 0) return;
    movedByKey.current = false;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!shown) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      movedByKey.current = true;
      setActive(event.key === 'ArrowDown' ? Math.min(active + 1, count - 1) : Math.max(active - 1, 0));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      (onPick ?? pickRef.current)?.(active);
    }
  };

  return {
    listId,
    active,
    optionId,
    inputProps: {
      role: 'combobox',
      'aria-expanded': shown,
      'aria-controls': listId,
      'aria-autocomplete': 'list',
      'aria-activedescendant': active >= 0 ? optionId(active) : undefined,
      onKeyDown,
    },
    reset: () => setActive(0),
    pickRef,
  };
}
