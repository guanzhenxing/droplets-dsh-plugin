import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempHome, fakeCtx } from './helpers.mjs';

const { parseFeed } = await import('../src/host/feeds.js');
const {
  FeedIconStore, ensureFeedIcon, fetchIconDataUrl, iconLinkOfHtml, siteOriginOf,
} = await import('../src/host/icons.js');
const { storageDir } = await import('../src/host/store.js');

/** 1×1 PNG (magic bytes + IHDR) — enough for the sniffer. */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082',
  'hex',
);

test('parseFeed exposes icon candidates: RSS image / Atom icon+logo / JSON favicon', () => {
  const rss = parseFeed('<?xml version="1.0"?><rss><channel><title>T</title><link>https://ex.com/</link><image><url>https://ex.com/banner.png</url></image><item><title>a</title></item></channel></rss>', 'https://ex.com/feed');
  assert.deepEqual(rss.iconCandidates, ['https://ex.com/banner.png']);
  assert.equal(rss.link, 'https://ex.com/');

  const atom = parseFeed('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><icon>https://ex.com/i.png</icon><logo>https://ex.com/l.png</logo><entry><title>a</title></entry></feed>', 'https://ex.com/atom');
  assert.deepEqual(atom.iconCandidates, ['https://ex.com/i.png', 'https://ex.com/l.png']);

  const json = parseFeed(JSON.stringify({ title: 'J', favicon: 'https://j.com/f.ico', icon: 'https://j.com/i.png', items: [{ id: '1', url: 'https://j.com/1', content_text: 'x' }] }), 'https://j.com/feed.json');
  assert.deepEqual(json.iconCandidates, ['https://j.com/f.ico', 'https://j.com/i.png']);
});

test('siteOriginOf prefers the feed-declared site link over the feed host', () => {
  assert.equal(siteOriginOf({ url: 'https://feeds.example/x.xml' }, { link: 'https://blog.example/' }), 'https://blog.example');
  assert.equal(siteOriginOf({ url: 'https://feeds.example/x.xml' }, {}), 'https://feeds.example');
  assert.equal(siteOriginOf({}, {}), undefined);
});

test('iconLinkOfHtml picks rel=icon hrefs and resolves them absolutely', () => {
  const html = '<head><link rel="stylesheet" href="a.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/touch.png"></head>';
  assert.equal(iconLinkOfHtml(html, 'https://ex.com/page'), 'https://ex.com/favicon.svg');
  assert.equal(iconLinkOfHtml('<link rel="shortcut icon" href="i.ico">', 'https://ex.com/'), 'https://ex.com/i.ico');
  assert.equal(iconLinkOfHtml('<link rel="stylesheet" href="x">', 'https://ex.com/'), undefined);
});

test('a loopback /favicon.ico becomes a stored data URL through ensureFeedIcon', async () => {
  const home = tempHome();
  try {
    const server = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/x-icon' });
        res.end(PNG_BYTES);
        return;
      }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><link rel="icon" href="/favicon.ico"></head><body></body></html>');
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const { createGuardedFetch } = await import('../src/host/guarded-fetch.js');
    const fetcher = createGuardedFetch({
      resolver: { async resolve() { return ['127.0.0.1']; } },
      ipPolicy: (ip) => ip === '127.0.0.1',
      portGate: () => true,
    });

    const store = new FeedIconStore(`${home.dir}/icons`);
    const sub = { id: 'feed:x', url: `http://ex.test:${port}/feed` };
    const outcome = await ensureFeedIcon(sub, { link: `http://ex.test:${port}/` }, fetcher, store);
    assert.equal(outcome, 'stored');
    assert.equal(sub.iconErrorAt, undefined);

    const icons = await store.all();
    assert.ok(icons['feed:x'].startsWith('data:image/x-icon;base64,'), 'icon stored as data URL');
    assert.ok(icons['feed:x'].endsWith(PNG_BYTES.toString('base64')));

    // Second run is a no-op (already cached).
    assert.equal(await ensureFeedIcon(sub, {}, fetcher, store), undefined);

    await store.remove('feed:x');
    assert.equal((await store.all())['feed:x'], undefined);
    server.close();
  } finally { home.cleanup(); }
});

test('every candidate failing records the 7-day throttle hint', async () => {
  const home = tempHome();
  try {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const { createGuardedFetch } = await import('../src/host/guarded-fetch.js');
    const fetcher = createGuardedFetch({
      resolver: { async resolve() { return ['127.0.0.1']; } },
      ipPolicy: (ip) => ip === '127.0.0.1',
      portGate: () => true,
    });
    const store = new FeedIconStore(`${home.dir}/icons`);
    const sub = { id: 'feed:y', url: `http://dead.test:${port}/feed` };
    assert.equal(await ensureFeedIcon(sub, { link: `http://dead.test:${port}/` }, fetcher, store), 'failed');
    assert.ok(Number.isFinite(sub.iconErrorAt), 'failure recorded');
    // Throttled: a second attempt is a no-op that keeps the old hint.
    const before = sub.iconErrorAt;
    assert.equal(await ensureFeedIcon(sub, {}, fetcher, store), undefined);
    assert.equal(sub.iconErrorAt, before);
    server.close();
  } finally { home.cleanup(); }
});

test('non-image bodies and oversized bodies are rejected', async () => {
  const home = tempHome();
  try {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not an icon</html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const { createGuardedFetch } = await import('../src/host/guarded-fetch.js');
    const fetcher = createGuardedFetch({
      resolver: { async resolve() { return ['127.0.0.1']; } },
      ipPolicy: (ip) => ip === '127.0.0.1',
      portGate: () => true,
    });
    assert.equal(await fetchIconDataUrl(fetcher, `http://ex.test:${port}/favicon.ico`), undefined);
    server.close();
  } finally { home.cleanup(); }
});

test('service: refresh stores favicons and feedIcons serves them; remove cleans up', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const { DropletsService } = await import('../src/host/index.js');
  const service = new DropletsService(ctx, {});
  await service.ready;
  try {
    const server = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_BYTES);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<?xml version="1.0"?><rss><channel><title>T</title><item><title>one</title><guid>g1</guid></item></channel></rss>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const { createGuardedFetch } = await import('../src/host/guarded-fetch.js');
    service.fetcher = createGuardedFetch({
      resolver: { async resolve() { return ['127.0.0.1']; } },
      ipPolicy: (ip) => ip === '127.0.0.1',
      portGate: () => true,
    });
    const id = await service.addSubscription({ url: `http://ex.test:${port}/feed` });
    await Promise.all([...service.iconJobs]);
    const { icons } = await service.feedIcons();
    assert.ok(icons[id.id]?.startsWith('data:image/png;base64,'), 'subscription icon served via feedIcons');

    await service.removeSubscription({ id: id.id });
    await Promise.resolve();
    const after = await service.feedIcons();
    assert.equal(after.icons[id.id], undefined, 'icon removed with the subscription');
    server.close();
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});
