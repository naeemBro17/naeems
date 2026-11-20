import { useCallback, useSyncExternalStore } from 'react';
import type { MergeDraft } from './merge';

/**
 * Batch 54: the statement being merged lives only in this tab's memory
 * (never uploaded, never saved) while Naeem moves between the review page
 * and a receipt. One per customer; gone on a reload or after Merge.
 */
const drafts = new Map<string, MergeDraft>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMergeDraft(customerKey: string, draft: MergeDraft | null): void {
  if (draft) drafts.set(customerKey, draft);
  else drafts.delete(customerKey);
  emit();
}

export function useMergeDraft(customerKey: string): [MergeDraft | null, (change: (d: MergeDraft) => MergeDraft) => void] {
  const draft = useSyncExternalStore(subscribe, () => drafts.get(customerKey) ?? null);
  const update = useCallback(
    (change: (d: MergeDraft) => MergeDraft) => {
      const now = drafts.get(customerKey);
      if (now) setMergeDraft(customerKey, change(now));
    },
    [customerKey]
  );
  return [draft, update];
}
