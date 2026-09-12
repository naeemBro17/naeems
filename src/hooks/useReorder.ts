import { useCallback, useState } from 'react';

/**
 * Drag-to-reorder state for a list the admin arranges by hand. HTML5 drag
 * events cover desktop; the returned `move` also backs up/down buttons so
 * the same list is reorderable by touch, where HTML5 drag doesn't fire.
 */
export function useReorder<T>(items: T[], setItems: (next: T[]) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
        return;
      }
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setItems(next);
    },
    [items, setItems]
  );

  const dropOn = useCallback(
    (targetIndex: number) => {
      if (dragIndex !== null) move(dragIndex, targetIndex);
      setDragIndex(null);
    },
    [dragIndex, move]
  );

  return { dragIndex, setDragIndex, move, dropOn };
}
