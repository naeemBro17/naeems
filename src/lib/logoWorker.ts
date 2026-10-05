import { cleanLogoBlob } from './logoClean';
import type { LogoWorkerReply, LogoWorkerRequest } from './brandLogoCache';

/* The brand-logo clean-up, off the main thread (Batch 29 Part 5): fetches
   one logo, cleans it (lib/logoClean.ts) and sends the result back. Any
   failure (unreadable file, no CORS) is reported, never thrown — the shop
   then simply shows the logo as it is. */

interface WorkerScope {
  onmessage: ((event: MessageEvent<LogoWorkerRequest>) => void) | null;
  postMessage: (message: LogoWorkerReply) => void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, fetchUrl } = event.data;
  void (async () => {
    try {
      const res = await fetch(fetchUrl, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cleaned = await cleanLogoBlob(await res.blob());
      scope.postMessage({ id, ok: true, ...cleaned });
    } catch {
      scope.postMessage({ id, ok: false });
    }
  })();
};
