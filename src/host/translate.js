/**
 * Entry translation: host-side LLM generation with a per-feed cache.
 *
 * Pattern follows the design docs (§6.3 条目翻译, qiaomu-rss ai.js 范式):
 * resolve the profile's default model via `agentDefaultModel`, stream the
 * article text through `llm.stream`, and cache the resulting Markdown so a
 * hit never re-requests. Both services are resolved at call time — a
 * profile without an LLM keeps the rest of the plugin alive and gets a
 * friendly error instead.
 *
 * The cache lives in per-feed files under
 * `storages/droplets-dsh/translations/<feedId>.json` (same layout as the
 * per-feed entry files), so cached translations never bloat data.json and
 * die with the subscription when it is removed.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** How much article text is offered to the model (chars, ~ matches qiaomu). */
const MAX_TRANSLATION_INPUT = 12_000;

export const TRANSLATE_SYSTEM_PROMPT = [
  '你是一位专业的中文科技翻译。把用户提供的文章完整翻译成简体中文：',
  '- 保留原文的结构（标题、小节、列表、代码块），不要增删内容',
  '- 专有名词、产品名、人名保留原文，首次出现时可在括号内附上原文',
  '- 输出使用 Markdown 格式，第一行输出「# <中文标题>」',
  '- 不要输出任何解释、前言或总结，只输出译文本身',
].join('\n');

/**
 * Stream one completion through the host llm service using the profile's
 * default model. Throws readable errors; resolves to the trimmed text.
 */
export async function completeWithLlm(ctx, { system, user, signal }) {
  const model = ctx.get?.('agentDefaultModel');
  const llm = ctx.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('当前配置没有可用的 LLM 服务，无法生成译文');
  }
  let provider;
  let modelId;
  if (model && typeof model.currentSelection === 'function') {
    const selection = model.currentSelection();
    provider = selection?.provider;
    modelId = selection?.model;
  }
  if (!provider || !modelId) {
    throw new Error('尚未选择默认模型，请先在设置中选择一个模型再使用翻译');
  }
  const { createSystemMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const messages = [
    createSystemMessage(system),
    createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }),
  ];
  const stream = llm.stream({ provider, model: modelId, messages, ...(signal ? { signal } : {}) });
  let text = '';
  let finished = false;
  for await (const chunk of stream) {
    if (signal?.aborted) throw new Error('droplets: 翻译已中止');
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && text === '') text = chunk.block.text;
    else if (chunk.type === 'finish') {
      finished = true;
      if (chunk.reason?.kind === 'error') {
        throw new Error(`模型调用失败：${chunk.reason.failure?.message ?? '未知错误'}`);
      }
      if (chunk.reason?.kind === 'aborted') throw new Error('droplets: 翻译已中止');
      break;
    }
  }
  if (!finished && text === '') throw new Error('模型没有返回任何内容');
  const cleaned = text.replace(/^```(?:markdown)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (cleaned === '') throw new Error('模型返回了空译文');
  return cleaned;
}

/** Build the user payload: title + readable text, bounded. */
export function translationInputOf(entry, htmlToText) {
  const heading = entry.title ? `标题: ${String(entry.title).slice(0, 500)}\n\n` : '';
  const plain = htmlToText(entry.html ?? '', MAX_TRANSLATION_INPUT + 1);
  const available = Math.max(0, MAX_TRANSLATION_INPUT - heading.length);
  const truncated = plain.length > available;
  const suffix = truncated ? '\n（上下文已截断）' : '';
  return heading + plain.slice(0, Math.max(0, available - suffix.length)) + suffix;
}

/** First Markdown H1 as the translated title, else the entry's own title. */
export function titleOfTranslation(markdown, fallback) {
  const heading = /^#\s+(.+)$/m.exec(String(markdown ?? ''));
  return heading?.[1]?.trim() || fallback;
}

/** Per-feed translation cache on disk (lazy, pruned to live entry keys). */
export class TranslationStore {
  constructor(dir, logger) {
    this.dir = dir;
    this.logger = logger;
    this.loaded = new Map(); // feedId -> { [entryKey]: record }
  }

  fileOf(feedId) {
    return join(this.dir, encodeURIComponent(feedId) + '.json');
  }

  /** Load (once) and prune one feed's translations to its live entry keys. */
  async feedMap(feedId, liveKeys) {
    if (this.loaded.has(feedId)) return this.loaded.get(feedId);
    let map = {};
    try {
      const parsed = JSON.parse(await readFile(this.fileOf(feedId), 'utf8'));
      if (parsed && typeof parsed === 'object') map = parsed;
    } catch { /* no cache yet */ }
    const keep = {};
    for (const key of liveKeys) if (map[key] !== undefined) keep[key] = map[key];
    this.loaded.set(feedId, keep);
    return keep;
  }

  get(feedId, entryKey) {
    return this.loaded.get(feedId)?.[entryKey];
  }

  put(feedId, entryKey, record) {
    let map = this.loaded.get(feedId);
    if (!map) { map = {}; this.loaded.set(feedId, map); }
    map[entryKey] = record;
    const target = this.fileOf(feedId);
    const write = async () => {
      const temp = `${target}.${process.pid}.tmp`;
      try {
        await mkdir(this.dir, { recursive: true });
        await writeFile(temp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        this.logger?.warn?.(`droplets: cannot cache translation for ${feedId}: ${String(error)}`);
      }
    };
    return write();
  }

  remove(feedId) {
    this.loaded.delete(feedId);
    return rm(this.fileOf(feedId), { force: true }).catch(() => {});
  }
}
