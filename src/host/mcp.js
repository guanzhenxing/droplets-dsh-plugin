/**
 * Inbox MCP — the reader's open API.
 *
 * A minimal, stateless MCP server over the Streamable HTTP transport, exposing
 * the inbox's capture/triage operations as tools. It rides the host webServer
 * (exact route, own bearer token) so ANY MCP client can drive the inbox:
 * in-profile agents via ctx.mcpManager.register (the manager connects back to
 * our own loopback URL, so agent tools arrive through the standard MCP path),
 * and external clients (Claude Desktop &c.) by configuring the same URL + token.
 *
 * The wire protocol is deliberately hand-rolled (JSON-RPC over POST, plain
 * JSON responses, no sessions): the official client's StreamableHTTPClient
 * transport accepts non-SSE JSON responses, tolerates 405 on the optional GET
 * stream, and never needs a session id for stateless servers. Everything the
 * droplets tools already do for agents (defineTool) stays untouched — this is
 * a second transport over the same inbox operations, not a replacement.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MCP_ENDPOINT_PATH = '/droplets-inbox/mcp';
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'droplets-inbox', version: '0.5.0' };

export function inboxMcpPath() {
  return MCP_ENDPOINT_PATH;
}

/** Sidecar token file next to the plugin's other private state. */
function tokenFile(storageDir) {
  return join(storageDir, 'mcp.json');
}

/** Load (or create) the bearer token external MCP clients must present. */
export async function loadOrCreateMcpToken(storageDir, logger) {
  const file = tokenFile(storageDir);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (typeof raw.token === 'string' && raw.token.length >= 16) return raw;
  } catch { /* first boot or corrupted: recreate */ }
  const record = { token: randomBytes(24).toString('base64url'), createdAt: new Date().toISOString() };
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    logger?.warn?.(`droplets: cannot persist MCP token: ${String(error)}`);
    throw error;
  }
  return record;
}

/** Mint a fresh token (settings「轮换令牌」). Returns the new record. */
export async function rotateMcpToken(storageDir, logger) {
  await rm(tokenFile(storageDir), { force: true }).catch(() => {});
  return loadOrCreateMcpToken(storageDir, logger);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function textResult(id, text, isError = false) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      ...(isError ? { isError: true } : {}),
    },
  };
}

function errorResult(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Render one inbox item the way both the agent tool and MCP show it. */
function inboxLine(item) {
  const tags = Array.isArray(item?.tags) && item.tags.length > 0 ? ` [${item.tags.join(',')}]` : '';
  const when = item?.createdAt ? ` (${new Date(item.createdAt).toISOString().slice(0, 10)})` : '';
  return `- ${item.id} | ${item.title ?? '未命名'}${when}${tags} | ${item.status ?? ''}`;
}

/**
 * The tool surface. Mirrors the inbox half of the 'droplets_inbox' agent tool
 * plus tag updates, because an agent filing items into a knowledge base needs
 * to relabel while triaging.
 */
export function inboxMcpTools() {
  return [
    {
      name: 'inbox_list',
      description: 'List inbox items (capture queue). filter: all | unread | finished | fetch_failed; tag narrows by tag.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['all', 'unread', 'finished', 'fetch_failed'], description: '默认 unread。' },
          tag: { type: 'string' },
          limit: { type: 'number', description: '返回上限(默认 20)。' },
        },
      },
    },
    {
      name: 'inbox_read',
      description: 'Read one inbox item: metadata plus the stored markdown body (or extracted text layer for PDF/EPUB).',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: '条目 id(inbox_list 返回)。' } },
        required: ['key'],
      },
    },
    {
      name: 'inbox_add_url',
      description: 'Capture a URL into the inbox (real fetch: first byte 20s / total 60s / 50MB cap).',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) 地址。' } },
        required: ['url'],
      },
    },
    {
      name: 'inbox_update',
      description: "Update one item's tags (agent triage: label items while filing them).",
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '条目 id。' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['key'],
      },
    },
    {
      name: 'inbox_mark_done',
      description: 'Finish one item: action library keeps it in the Droplets library, trash moves it to the recoverable recycle bin. Default trash.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '条目 id。' },
          action: { type: 'string', enum: ['library', 'trash'] },
        },
        required: ['key'],
      },
    },
  ];
}

async function callTool(service, name, args) {
  switch (name) {
    case 'inbox_list': {
      const filter = args?.filter === 'all' || args?.filter === 'finished' || args?.filter === 'fetch_failed'
        ? args.filter
        : 'unread';
      const { items, counts } = await service.inboxList({ status: filter, tag: args?.tag });
      const limit = Math.min(Number.isFinite(args?.limit) ? args.limit : 20, 50);
      const page = (items ?? []).slice(0, limit);
      if (page.length === 0) return `收件箱(${filter})没有条目。`;
      const header = `条目 ${page.length}${(items ?? []).length > page.length ? '/${items.length}+' : ''} · 未读 ${counts?.unread ?? '?'}:`;
      return [header, ...page.map(inboxLine)].join('\n');
    }
    case 'inbox_read': {
      if (typeof args?.key !== 'string' || args.key === '') throw new Error('inbox_read 需要 key(inbox_list 返回)');
      const { item, text } = await service.inboxRead({ key: args.key });
      const header = [
        `# ${item?.title ?? '未命名'}`,
        '',
        item?.source?.url ? `原文: ${item.source.url}` : null,
        item?.createdAt ? `收录时间: ${new Date(item.createdAt).toISOString()}` : null,
        Array.isArray(item?.tags) && item.tags.length > 0 ? `标签: ${item.tags.join(', ')}` : null,
        '',
      ].filter((line) => line !== null).join('\n');
      const body = String(text ?? '');
      return body === '' ? `${header}(这条没有可读正文)` : `${header}\n${body.slice(0, 60_000)}${body.length > 60_000 ? '\n(正文过长已截断)' : ''}`;
    }
    case 'inbox_add_url': {
      if (typeof args?.url !== 'string' || !/^https?:\/\//i.test(args.url)) throw new Error('inbox_add_url 需要 http(s) url');
      const { item, duplicate } = await service.inboxAddUrl({ url: args.url });
      return duplicate
        ? `收件箱里已有这一条(${item.id}),未重复抓取。`
        : `已加入收件箱:${item.id}(${item.title ?? '抓取中'})。`;
    }
    case 'inbox_update': {
      if (typeof args?.key !== 'string' || args.key === '') throw new Error('inbox_update 需要 key');
      const tags = Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string') : undefined;
      const { item } = await service.inboxUpdate({ id: args.key, patch: { tags } });
      return `已更新标签:${item?.title ?? args.key} → [${(item?.tags ?? []).join(', ')}]`;
    }
    case 'inbox_mark_done': {
      if (typeof args?.key !== 'string' || args.key === '') throw new Error('inbox_mark_done 需要 key');
      const action = args?.action === 'library' ? 'library' : 'trash';
      if (action === 'library') {
        await service.inboxMoveToLibrary({ id: args.key });
        return `已处理完成并保留到资料库:${args.key}。`;
      }
      await service.inboxMoveToTrash({ id: args.key });
      return `已处理完成并移入回收站(可恢复):${args.key}。`;
    }
    default:
      throw new Error(`未知工具:${name}`);
  }
}

/** Dispatch one JSON-RPC request object. Notifications return undefined. */
async function dispatch(service, message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return errorResult(null, -32600, 'Invalid Request');
  }
  const { id, method } = message;
  const isNotification = id === undefined || id === null;
  if (method === 'initialize') {
    const requested = message.params?.protocolVersion;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof requested === 'string' && requested !== '' ? requested : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Droplets 收件箱:网页/PDF/EPUB 的待读队列。典型代理工作流:inbox_list 过滤 unread → inbox_read 读正文 → 决定去留(存知识库/丢弃) → inbox_mark_done 收尾,处理中可用 inbox_update 打标签。',
      },
    };
  }
  if (method === 'notifications/initialized' || (isNotification && typeof method === 'string' && method.startsWith('notifications/'))) {
    return undefined;
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: inboxMcpTools() } };
  if (method === 'tools/call') {
    const name = message.params?.name;
    if (typeof name !== 'string') return errorResult(id, -32602, 'tools/call requires params.name');
    try {
      const text = await callTool(service, name, message.params?.arguments ?? {});
      return textResult(id, String(text));
    } catch (error) {
      // MCP: a tool's own failure is a result with isError, not a transport error.
      return textResult(id, String(error?.message ?? error), true);
    }
  }
  if (isNotification) return undefined;
  return errorResult(id, -32601, `Method not found: ${String(method)}`);
}

/**
 * The webServer route handler. Owns the full response lifecycle; auth is a
 * bearer token (read through getToken so rotations apply without re-binding
 * the route) checked before anything else (401 otherwise).
 */
export function createInboxMcpHandler(service, { getToken }) {
  return async (req, res) => {
    try {
      const authorization = String(req.headers.authorization ?? '');
      const token = getToken();
      if (typeof token !== 'string' || authorization !== 'Bearer ' + token) {
        json(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid or missing bearer token' } });
        return;
      }
      if (req.method === 'GET') {
        // Stateless server: no server-initiated stream. The client tolerates 405.
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        // Stateless server: no sessions to terminate.
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        json(res, 400, errorResult(null, -32700, 'Parse error'));
        return;
      }
      const batch = Array.isArray(message) ? message : [message];
      if (batch.length === 0) {
        json(res, 400, errorResult(null, -32600, 'Invalid Request'));
        return;
      }
      const replies = [];
      for (const entry of batch) {
        const reply = await dispatch(service, entry);
        if (reply !== undefined) replies.push(reply);
      }
      if (replies.length === 0) {
        // Pure notifications: accepted, nothing to say.
        res.writeHead(202);
        res.end();
        return;
      }
      json(res, 200, Array.isArray(message) ? replies : replies[0]);
    } catch (error) {
      if (!res.headersSent) {
        json(res, 500, errorResult(null, -32603, 'Internal error'));
      } else {
        res.end();
      }
    }
  };
}
