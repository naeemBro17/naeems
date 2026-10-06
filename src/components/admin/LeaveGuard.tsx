import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../shared/ConfirmDialog';

/**
 * Batch 32 Part 3 — "Discard changes?". Once anything is typed on an admin
 * page (New order, Edit order, a product, a customer), leaving it asks first
 * — whichever way: the page's own Back, the phone's Back button, another
 * sidebar / bottom-bar item, or closing / reloading the tab. Never loses
 * work silently.
 *
 * The phone's Back can't be cancelled, so while something is typed one
 * extra history entry (same address) sits on top: Back removes that entry
 * instead of leaving, and the question appears. Sheets opened on the page
 * (thana picker, confirmations) push their own entry above it, so closing
 * them never counts as leaving.
 */
interface LeaveGuardApi {
  markDirty: () => void;
  /** Runs `go` now — or, when something was typed, after "Discard". */
  requestLeave: (go: () => void) => void;
  /** Runs `go` without asking (after a successful save). */
  leave: (go: () => void) => void;
  /** Everything typed so far was saved (the page stays open). */
  markClean: () => void;
}

const LeaveGuardContext = createContext<LeaveGuardApi>({
  markDirty: () => undefined,
  requestLeave: (go) => go(),
  leave: (go) => go(),
  markClean: () => undefined,
});

export function useLeaveGuard(): LeaveGuardApi {
  return useContext(LeaveGuardContext);
}

interface ProviderProps {
  /** What the phone's Back does once "Discard" is chosen. */
  onBack: () => void;
  children: ReactNode;
}

export function LeaveGuardProvider({ onBack, children }: ProviderProps) {
  const [dirty, setDirty] = useState(false);
  const [pending, setPendingState] = useState<{ go: () => void } | null>(null);
  const pendingRef = useRef<{ go: () => void } | null>(null);
  const setPending = useCallback((next: { go: () => void } | null) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);
  const dirtyRef = useRef(false);
  const guardIdRef = useRef<string | null>(null);
  const afterRemoveRef = useRef<(() => void) | null>(null);
  // True while our own history.back() (taking the extra entry off) is
  // still on its way — a second leave in that moment must not step back
  // twice; it waits for the same one.
  const removingRef = useRef(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const pushGuard = useCallback(() => {
    if (guardIdRef.current || !dirtyRef.current) return;
    const id = Math.random().toString(36).slice(2);
    guardIdRef.current = id;
    window.history.pushState({ leaveGuardId: id }, '');
  }, []);

  useEffect(() => {
    if (dirty) pushGuard();
  }, [dirty, pushGuard]);

  useEffect(() => {
    const onPop = () => {
      if (removingRef.current) {
        removingRef.current = false;
        guardIdRef.current = null;
        const after = afterRemoveRef.current;
        afterRemoveRef.current = null;
        after?.();
        return;
      }
      const id = guardIdRef.current;
      if (!id) return;
      // Back onto our own entry (a sheet above it closed): nothing to do.
      if ((window.history.state as { leaveGuardId?: string } | null)?.leaveGuardId === id) return;
      guardIdRef.current = null;
      if (dirtyRef.current) setPending({ go: () => onBackRef.current() });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Read at the moment of leaving: a save that just finished counts.
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const markDirty = useCallback(() => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
  }, []);

  const leave = useCallback((go: () => void) => {
    dirtyRef.current = false;
    setDirty(false);
    setPending(null);
    if (removingRef.current) {
      const before = afterRemoveRef.current;
      afterRemoveRef.current = () => {
        before?.();
        go();
      };
      return;
    }
    const id = guardIdRef.current;
    if (id && (window.history.state as { leaveGuardId?: string } | null)?.leaveGuardId === id) {
      // Take our extra entry off first, then go.
      removingRef.current = true;
      afterRemoveRef.current = go;
      window.history.back();
      return;
    }
    guardIdRef.current = null;
    go();
  }, []);

  const requestLeave = useCallback(
    (go: () => void) => {
      if (!dirtyRef.current) {
        leave(go);
        return;
      }
      setPending({ go });
    },
    [leave]
  );

  // Saved while "Discard changes?" was waiting (Back pressed during the
  // save): nothing is unsaved any more, so go where they asked to go.
  const markClean = useCallback(() => {
    const asked = pendingRef.current;
    leave(asked ? asked.go : () => undefined);
  }, [leave]);

  const api = useMemo(() => ({ markDirty, requestLeave, leave, markClean }), [markDirty, requestLeave, leave, markClean]);

  return (
    <LeaveGuardContext.Provider value={api}>
      {children}
      <ConfirmDialog
        isOpen={pending !== null}
        title="Discard changes?"
        message="What you typed on this page has not been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        backCloses={false}
        onConfirm={() => {
          const go = pending?.go;
          if (go) leave(go);
        }}
        onClose={() => {
          setPending(null);
          pushGuard();
        }}
      />
    </LeaveGuardContext.Provider>
  );
}
