// node scripts/measure-egress.mjs [baseURL]
//
// Batch 40 Part 0: how much the shop downloads from Supabase on a first
// visit and on a second visit (reload), page by page, at phone size. Opens
// the built shop (default: `npm run preview` on port 4174) in a real
// browser and counts every file from Supabase Storage and every database
// call, with the bytes that really came over the network — a file the
// browser or the offline helper already had counts as 0.
//
// It downloads real files on purpose (a few MB per run), so run it by hand
// only when measuring, never from the tests.
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';

const BASE = process.argv[2] ?? 'http://localhost:4174';
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const SUPABASE = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY;

const SUPABASE_HOST = new URL(SUPABASE).host;

/**
 * The real bytes Supabase sent, whatever cache answered the page: the
 * browser talks to Supabase through this little local tunnel, which counts
 * everything coming back from Supabase's address (files and database
 * together, encrypted, so not split by kind). A file the browser or the
 * offline helper already had never crosses it.
 */
let tunnelBytes = 0;
const tunnel = createServer();
tunnel.on('connect', (req, client, head) => {
  const [host, port] = req.url.split(':');
  const upstream = connect(Number(port) || 443, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  if (req.url.startsWith(SUPABASE_HOST)) upstream.on('data', (d) => (tunnelBytes += d.length));
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
const PROXY = `http://127.0.0.1:${tunnel.address().port}`;
function takeTunnelKB() {
  const kb = Math.round(tunnelBytes / 1024);
  tunnelBytes = 0;
  return kb;
}

async function rest(path) {
  const res = await fetch(`${SUPABASE}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return res.json();
}

/** Watches one page through the browser's own network log. */
async function watch(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  const reqs = new Map();
  cdp.on('Network.requestWillBeSent', (e) => {
    reqs.set(e.requestId, { url: e.request.url, bytes: 0, cached: false });
  });
  cdp.on('Network.requestServedFromCache', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.cached = true;
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    const src = e.response.serviceWorkerResponseSource;
    if (e.response.fromDiskCache || e.response.fromPrefetchCache) r.cached = true;
    if (e.response.fromServiceWorker && src && src !== 'network') r.cached = true;
    r.viaWorker = e.response.fromServiceWorker === true;
    r.length = Number(e.response.headers['content-length'] ?? e.response.headers['Content-Length'] ?? 0);
  });
  cdp.on('Network.dataReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.data = (r.data ?? 0) + e.dataLength;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.bytes = e.encodedDataLength;
  });
  return () => {
    const out = { storageFiles: 0, storageDownloaded: 0, storageKB: 0, dbCalls: 0, dbKB: 0, videos: 0, videoKB: 0 };
    for (const r of reqs.values()) {
      if (!r.url.startsWith(SUPABASE)) continue;
      // A file answered by the offline helper from the network still came
      // over the wire once: the page sees the body size, not the headers.
      const net = r.cached ? 0 : r.viaWorker ? (r.data || r.length || 0) : r.bytes || r.data || 0;
      if (r.url.includes('/storage/v1/object/')) {
        out.storageFiles += 1;
        if (net > 0) out.storageDownloaded += 1;
        out.storageKB += net / 1024;
        if (/\.(mp4|webm)(\?|$)/i.test(r.url)) {
          out.videos += 1;
          out.videoKB += net / 1024;
        }
      } else {
        out.dbCalls += 1;
        out.dbKB += net / 1024;
      }
    }
    reqs.clear();
    for (const k of ['storageKB', 'dbKB', 'videoKB']) out[k] = Math.round(out[k]);
    out.realKB = takeTunnelKB();
    return out;
  };
}

async function settle(page, ms) {
  await page.waitForLoadState('load');
  await page.waitForTimeout(ms);
}

async function scrollToBottom(page) {
  for (let i = 0; i < 60; i += 1) {
    const done = await page.evaluate(() => {
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
    });
    await page.waitForTimeout(250);
    if (done) break;
  }
}

/**
 * A returning customer: the first visit (first screen, then scrolled to
 * the end), then the same page opened again twice.
 */
async function visits(browser, name, path, { scroll = false } = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  // Never send a fake visit to Facebook / Google while measuring.
  await context.route(/connect\.facebook\.net|facebook\.com\/tr|google-analytics\.com|googletagmanager\.com/, (r) => r.abort());
  const page = await context.newPage();
  const take = await watch(page);
  const out = {};
  takeTunnelKB();
  for (const visit of ['first', 'second', 'third']) {
    if (visit !== 'first') await page.goto('about:blank');
    await page.goto(BASE + path);
    await settle(page, 6000);
    if (visit === 'first') out.firstScreen = take();
    if (scroll) {
      await scrollToBottom(page);
      await page.waitForTimeout(5000);
    }
    out[visit] = take();
  }
  await context.close();
  return { name, path, ...out };
}

const products = await rest('products_view?select=slug,image_urls&is_active=eq.true');
products.sort((a, b) => (b.image_urls?.length ?? 0) - (a.image_urls?.length ?? 0));
const productSlug = products[0].slug;
const brands = await rest('brands?select=slug,banner_video_url&banner_video_url=not.is.null&order=display_order');
const brandSlug = brands[0]?.slug ?? 'sudocrem';

const browser = await chromium.launch({ proxy: { server: PROXY, bypass: 'localhost,127.0.0.1' } });
const results = [];
results.push(await visits(browser, 'Home', '/', { scroll: true }));
results.push(await visits(browser, `Product (${productSlug}, ${products[0].image_urls?.length ?? 0} photos)`, `/product/${productSlug}`, { scroll: true }));
results.push(await visits(browser, `Brand with video (${brandSlug})`, `/brand/${brandSlug}`, { scroll: true }));
results.push(await visits(browser, 'Admin sign-in page', '/admin-access'));
await browser.close();
tunnel.close();

// "files" = what Supabase really sent minus the database answers (those
// are never cached, so the page's own count of them is exact). "asked" =
// files the page asked for, whoever answered.
const row = (label, m) => {
  if (!m) return '';
  const files = Math.max(0, m.realKB - m.dbKB);
  return (
    `  ${label.padEnd(26)} files from Supabase: ${String(files).padStart(5)} KB (${String(m.storageFiles).padStart(3)} asked` +
    (m.videos ? `, ${m.videos} video` : '') +
    `) | database: ${String(m.dbKB).padStart(4)} KB in ${m.dbCalls} calls`
  );
};
for (const r of results) {
  console.log(`${r.name}  ${r.path}`);
  console.log(row('first visit, first screen', r.firstScreen));
  console.log(row('first visit, rest of page', r.first));
  console.log(row('second visit', r.second));
  console.log(row('third visit', r.third));
}
console.log(JSON.stringify(results));
