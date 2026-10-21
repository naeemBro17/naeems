import { createServer, type ViteDevServer } from 'vite';

/**
 * Batch 40: a Vite dev server for this one test file, so the test browser
 * can load the shop's own source modules (e2e/harness/*.ts imports
 * src/lib/...) and run them directly. Nothing here reaches Supabase.
 */
export async function startDevServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: ViteDevServer = await createServer({
    logLevel: 'silent',
    clearScreen: false,
    server: { port: 4190, strictPort: false, hmr: false },
    // Prepared up front, so the page is never reloaded half-way through.
    optimizeDeps: { include: ['mediabunny'] },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error('The test dev server did not start.');
  }
  return { url, close: () => server.close() };
}
