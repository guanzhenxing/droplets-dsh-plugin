import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, parseOpml, buildOpml, mergeEntries, entryKeyOf, subscriptionIdOf } from '../src/host/feeds.js';

const RSS = '<?xml version="1.0" encoding="UTF-8"?>' +
  '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">' +
  '<channel><title>Test Feed &amp; More</title><link>https://example.com/</link><description>d</description>' +
  '<item><title>First post</title><link>https://example.com/first</link>' +
  '<guid isPermaLink="false">post-1</guid><pubDate>Wed, 24 Sep 2025 08:00:00 GMT</pubDate>' +
  '<description><![CDATA[<p>Hello <b>world</b> <script>alert(1)</script></p>]]></description>' +
  '<content:encoded><![CDATA[<p>Full <em>content</em> <a href="/relative">link</a></p>]]></content:encoded>' +
  '</item>' +
  '<item><title>Second</title><link>https://example.com/second</link><guid>post-2</guid></item>' +
  '</channel></rss>';

const ATOM = '<?xml version="1.0"?>' +
  '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>' +
  '<link rel="alternate" href="https://atom.example/"/>' +
  '<entry><id>urn:uuid:aaa-bbb</id><title>Atom entry</title>' +
  '<link href="https://atom.example/1"/>' +
  '<updated>2025-09-20T10:00:00Z</updated>' +
  '<content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry></feed>';

const JSON_FEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON Feed',
  home_page_url: 'https://json.example/',
  items: [
    { id: 'jf-1', url: 'https://json.example/1', title: 'Item one', content_html: '<p>One</p>', date_published: '2025-09-01T00:00:00Z' },
    { id: 'jf-2', url: 'https://json.example/2', title: 'Item two', content_text: 'Plain text body' },
  ],
});

test('parses RSS 2.0 with content:encoded and sanitizes bodies', () => {
  const parsed = parseFeed(RSS, 'https://example.com/feed.xml');
  assert.equal(parsed.title, 'Test Feed & More');
  assert.equal(parsed.entries.length, 2);
  const first = parsed.entries[0];
  assert.equal(first.title, 'First post');
  assert.equal(first.url, 'https://example.com/first');
  assert.ok(!first.html.includes('script'), 'script stripped');
  assert.ok(first.html.includes('<em>content</em>'));
  assert.ok(first.html.includes('href="https://example.com/relative"'), 'relative URL resolved');
  assert.ok(/^feed:[0-9a-f]{32}\|post-1$/.test(first.key), 'key = ' + first.key);
  assert.equal(first.publishedAt, '2025-09-24T08:00:00.000Z');
});

test('parses Atom 1.0 entries', () => {
  const parsed = parseFeed(ATOM, 'https://atom.example/feed');
  assert.equal(parsed.title, 'Atom Feed');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].url, 'https://atom.example/1');
  assert.equal(parsed.entries[0].publishedAt, '2025-09-20T10:00:00.000Z');
  assert.ok(parsed.entries[0].html.includes('Body'));
});

test('parses JSON Feed 1.1', () => {
  const parsed = parseFeed(JSON_FEED, 'https://json.example/feed.json');
  assert.equal(parsed.title, 'JSON Feed');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[1].title, 'Item two');
  assert.ok(parsed.entries[1].html.includes('Plain text body'));
});

test('dedup key: guid wins, link hashed otherwise, stable per feed', () => {
  const feedId = subscriptionIdOf('https://example.com/feed.xml');
  const byGuid = entryKeyOf(feedId, { guid: 'abc' });
  const byLink = entryKeyOf(feedId, { link: 'https://example.com/x' });
  assert.equal(byGuid, feedId + '|abc');
  assert.equal(byLink, entryKeyOf(feedId, { link: 'https://example.com/x' }));
  assert.notEqual(byGuid, byLink);
  const otherFeed = subscriptionIdOf('https://other.example/feed');
  assert.notEqual(entryKeyOf(otherFeed, { guid: 'abc' }), byGuid);
});

test('mergeEntries refreshes in place without duplicating and keeps cached body', () => {
  const feedId = subscriptionIdOf('https://example.com/f');
  const a = { key: entryKeyOf(feedId, { guid: 'a' }), title: 'A', html: '<p>old</p>', publishedAt: '2025-09-01T00:00:00Z' };
  const b = { key: entryKeyOf(feedId, { guid: 'b' }), title: 'B', html: '', publishedAt: '2025-09-02T00:00:00Z' };
  const merged = mergeEntries([a, b], [
    { key: a.key, title: 'A2', html: '', publishedAt: '2025-09-01T00:00:00Z' },
    { key: entryKeyOf(feedId, { guid: 'c' }), title: 'C', html: '<p>c</p>', publishedAt: '2025-09-03T00:00:00Z' },
  ]);
  assert.equal(merged.length, 3);
  const a2 = merged.find((entry) => entry.title === 'A2');
  assert.equal(a2.html, '<p>old</p>', 'fresh entry without body keeps cached body');
  assert.equal(merged[0].title, 'C', 'newest first');
});

test('OPML round trip with nested groups', () => {
  const opml = '<?xml version="1.0"?><opml version="2.0"><body>' +
    '<outline text="Tech"><outline text="News" xmlUrl="https://a.example/feed"/></outline>' +
    '<outline type="rss" text="Loose" xmlUrl="https://b.example/feed"/>' +
    '<outline text="Bad" xmlUrl="ftp://no.example/feed"/>' +
    '</body></opml>';
  const parsed = parseOpml(opml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].group, 'Tech');
  assert.equal(parsed[0].name, 'News');
  const xml = buildOpml([{ url: 'https://a.example/feed', name: 'A', group: 'G' }]);
  const back = parseOpml(xml);
  assert.equal(back.length, 1);
  assert.equal(back[0].group, 'G');
});
