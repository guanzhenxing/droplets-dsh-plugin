import test from 'node:test';
import assert from 'node:assert/strict';
import { tempHome, fakeCtx } from './helpers.mjs';

const {
  TranslationStore, completeWithLlm, translationInputOf, titleOfTranslation,
} = await import('../src/host/translate.js');

/** A context whose llm streams one canned Markdown translation. */
function llmCtx({ text = '# 译文标题\n\n第一段。', fail = false } = {}) {
  const calls = { streams: 0 };
  const ctx = fakeCtx();
  ctx.get = (name) => {
    if (name === 'llm') {
      return {
        stream(options) {
          calls.streams += 1;
          // Two deltas exercise the concatenation path.
          const half = Math.floor(text.length / 2);
          const chunks = [
            { type: 'text-delta', text: text.slice(0, half) },
            { type: 'text-delta', text: text.slice(half) },
            fail
              ? { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }
              : { type: 'finish', reason: { kind: 'stop' } },
          ];
          return (async function* generate() {
            for (const chunk of chunks) yield chunk;
          })();
        },
      };
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'deepseek', model: 'test-model' }) };
    }
    return undefined;
  };
  return { ctx, calls };
}

test('completeWithLlm streams deltas and strips stray code fences', async () => {
  const { ctx } = llmCtx({ text: '```markdown\n# 标题\n\n正文\n```' });
  const out = await completeWithLlm(ctx, { system: 'sys', user: 'usr' });
  assert.equal(out, '# 标题\n\n正文');
});

test('completeWithLlm surfaces missing llm / missing model selection', async () => {
  const bare = fakeCtx();
  bare.get = () => undefined;
  await assert.rejects(() => completeWithLlm(bare, { system: 's', user: 'u' }), /LLM/);
  const noModel = fakeCtx();
  noModel.get = (name) => (name === 'llm' ? { stream: () => (async function* () {})() } : undefined);
  await assert.rejects(() => completeWithLlm(noModel, { system: 's', user: 'u' }), /默认模型/);
  const failing = llmCtx({ fail: true });
  await assert.rejects(() => completeWithLlm(failing.ctx, { system: 's', user: 'u' }), /boom/);
});

test('completeWithLlm passes the default model selection to llm.stream', async () => {
  const seen = [];
  const ctx = fakeCtx();
  ctx.get = (name) => {
    if (name === 'llm') {
      return {
        stream(options) {
          seen.push(options);
          return (async function* () {
            yield { type: 'text-delta', text: 'ok' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      };
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'm1' }) };
    return undefined;
  };
  await completeWithLlm(ctx, { system: 'sys', user: 'usr' });
  assert.equal(seen[0].provider, 'deepseek');
  assert.equal(seen[0].model, 'm1');
  assert.equal(seen[0].messages[0].role, 'system');
  assert.equal(seen[0].messages[1].content[0].text, 'usr');
});

test('translationInputOf bounds the payload and marks truncation', () => {
  // Minimal stand-in for sanitize.js htmlToText: strip tags, trim, cap.
  const htmlToText = (source, max) => String(source).replace(/<[^>]+>/g, ' ').trim().slice(0, Math.max(0, max));
  const entry = { title: 'T'.repeat(600), html: '<p>' + 'x'.repeat(20_000) + '</p>' };
  const input = translationInputOf(entry, htmlToText);
  assert.ok(input.length <= 12_000);
  assert.ok(input.includes('（上下文已截断）'));
  const short = translationInputOf({ title: 'A', html: '<p>hi</p>' }, htmlToText);
  assert.equal(short, '标题: A\n\nhi');
});

test('titleOfTranslation prefers the Markdown H1', () => {
  assert.equal(titleOfTranslation('# 中文标题\n\nx', 'fallback'), '中文标题');
  assert.equal(titleOfTranslation('no heading', 'fallback'), 'fallback');
});

test('TranslationStore: put/get, prune to live keys, remove', async () => {
  const home = tempHome();
  try {
    const dir = home.dir + '/translations';
    const store = new TranslationStore(dir);
    await store.put('feed:a', 'k1', { title: 't1', markdown: 'm1', generatedAt: '2026-01-01T00:00:00Z' });

    // A fresh store keeps the record when the entry is still live…
    const kept = new TranslationStore(dir);
    const liveMap = await kept.feedMap('feed:a', ['k1', 'k2']);
    assert.equal(liveMap.k1.markdown, 'm1');
    assert.equal(kept.get('feed:a', 'k1').markdown, 'm1');

    // …and another fresh load prunes it once the entry is gone.
    const pruned = new TranslationStore(dir);
    const prunedMap = await pruned.feedMap('feed:a', ['k2']);
    assert.equal(prunedMap.k1, undefined, 'stale translation pruned on load');

    await pruned.remove('feed:a');
    assert.equal(pruned.get('feed:a', 'k1'), undefined);
  } finally { home.cleanup(); }
});

test('service: translateEntry caches per entry and getEntry reports it', async () => {
  const home = tempHome();
  const { ctx, calls } = llmCtx({});
  const { DropletsService } = await import('../src/host/index.js');
  const service = new DropletsService(ctx, {});
  await service.ready;
  try {
    service.store.data.subscriptions.push({
      id: 'feed:t', url: 'https://t.example/f', name: 'T', enabled: true,
      entries: [
        { key: 'feed:t|e1', guid: 'e1', title: 'English post', url: 'https://t.example/1', html: '<p>Hello world</p>', summary: 's' },
      ],
    });

    const before = await service.getEntry({ key: 'feed:t|e1' });
    assert.equal(before.hasTranslation, false);

    const first = await service.translateEntry({ key: 'feed:t|e1' });
    assert.equal(first.cached, false);
    assert.equal(first.translation.title, '译文标题');
    assert.ok(first.translation.markdown.includes('第一段'));
    assert.equal(calls.streams, 1);

    const second = await service.translateEntry({ key: 'feed:t|e1' });
    assert.equal(second.cached, true, 'cache hit → no new model request');
    assert.equal(second.translation.title, '译文标题');
    assert.equal(calls.streams, 1);

    const after = await service.getEntry({ key: 'feed:t|e1' });
    assert.equal(after.hasTranslation, true);

    // Retiring the subscription drops its cached translation.
    await service.removeSubscription({ id: 'feed:t' });
    assert.equal(service.translations.get('feed:t', 'feed:t|e1'), undefined);
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});

test('service: translateEntry errors carry a readable message without LLM access', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  ctx.get = () => undefined;
  const { DropletsService } = await import('../src/host/index.js');
  const service = new DropletsService(ctx, {});
  await service.ready;
  try {
    service.store.data.subscriptions.push({
      id: 'feed:n', url: 'https://n.example/f', name: 'N', enabled: true,
      entries: [{ key: 'feed:n|e1', guid: 'e1', title: 'x', url: 'https://n.example/1', html: '<p>x</p>' }],
    });
    await assert.rejects(() => service.translateEntry({ key: 'feed:n|e1' }), /LLM/);
    await assert.rejects(() => service.translateEntry({ key: 'nope' }), /unknown entry/);
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});
