import type { Page } from '@playwright/test';

/**
 * Batch 61: the video review tests waited for a real YouTube video to start
 * over the internet, which made them slow and flaky (a timing flake in
 * every full run). The shop talks to its YouTube player only through
 * YouTube's documented postMessage protocol (src/components/viewer/
 * VideoReview.tsx), so this answers the embed page with a tiny stand-in on
 * the same origin: it starts "playing" (the embed asks for autoplay),
 * reports its state when the shop says it is listening, and follows the
 * playVideo / pauseVideo / mute commands. Nothing comes from YouTube.
 * A product the shop reads without a video gets a test video link, in this
 * browser only (the live products change; nothing is saved).
 */
const TEST_VIDEO = 'https://youtu.be/6SE9t5155ys';
const FAKE_PLAYER = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000}</style></head><body><script>
var state = 1;
var muted = false;
function send(info) { parent.postMessage(JSON.stringify({ event: 'infoDelivery', info: info }), '*'); }
window.addEventListener('message', function (e) {
  var d;
  try { d = JSON.parse(e.data); } catch (err) { return; }
  if (d.event === 'listening') { send({ playerState: state, muted: muted, currentTime: 1, duration: 300 }); return; }
  if (d.event !== 'command') return;
  if (d.func === 'playVideo') { state = 1; send({ playerState: 1 }); }
  if (d.func === 'pauseVideo') { state = 2; send({ playerState: 2 }); }
  if (d.func === 'mute') { muted = true; send({ muted: true }); }
  if (d.func === 'unMute') { muted = false; send({ muted: false }); }
});
</script></body></html>`;

export async function fakeYouTube(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/products_view\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>[] | Record<string, unknown> | null;
    const give = (row: Record<string, unknown>) =>
      'youtube_url' in row && !row.youtube_url ? { ...row, youtube_url: TEST_VIDEO } : row;
    const json = Array.isArray(body) ? body.map(give) : body ? give(body) : body;
    await route.fulfill({ response, json });
  });
  await page.route(/^https:\/\/www\.youtube-nocookie\.com\/embed\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PLAYER })
  );
}
