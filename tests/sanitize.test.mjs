import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, htmlToText, firstImageUrl, decodeHtmlEntities } from '../src/host/sanitize.js';

test('sanitizer strips scripts, handlers and javascript: URLs', () => {
  const dirty = '<p onclick="x()">ok</p><script>alert(1)</script>' +
    '<a href="javascript:alert(2)">bad</a><a href="https://ok.example/good">good</a>' +
    '<img src="x" onerror="y"><style>p{}</style>';
  const clean = sanitizeHtml(dirty, { baseUrl: 'https://ok.example/page' });
  assert.ok(!clean.includes('script'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('javascript:'));
  assert.ok(!clean.includes('style'));
  assert.ok(!clean.includes('onerror'));
  assert.ok(clean.includes('href="https://ok.example/good"'));
  assert.ok(clean.includes('<img src="https://ok.example/x" loading="lazy" referrerpolicy="no-referrer">'));
});

test('sanitizer resolves relative URLs against the base', () => {
  const clean = sanitizeHtml('<a href="/doc">x</a><img src="pic.png">', { baseUrl: 'https://base.example/a/b.html' });
  assert.ok(clean.includes('https://base.example/doc'));
  assert.ok(clean.includes('https://base.example/a/pic.png'));
});

test('unbalanced tags close safely and entities decode', () => {
  const clean = sanitizeHtml('<p>a &amp; b <strong>c');
  assert.ok(clean.endsWith('</strong></p>'));
  assert.equal(decodeHtmlEntities('a &amp; b &#x4e2d;'), 'a & b 中');
});

test('htmlToText keeps paragraph structure', () => {
  const text = htmlToText('<h1>T</h1><p>One</p><p>Two</p><br><p>Three</p>');
  assert.ok(text.includes('One'));
  assert.ok(text.includes('Three'));
  assert.ok(!text.includes('<'));
});

test('firstImageUrl extracts a safe image', () => {
  assert.equal(firstImageUrl('<img src="https://x.example/i.png">', undefined), 'https://x.example/i.png');
  assert.equal(firstImageUrl('<img src="javascript:alert(1)">', undefined), undefined);
});
