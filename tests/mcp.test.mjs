import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempHome, fakeCtx } from './helpers.mjs';

const { DropletsService } = await import('../src/host/index.js');
const { createInboxMcpHandler, inboxMcpPath, loadOrCreateMcpToken, rotateMcpToken, inboxMcpTools } = await import('../src/host/mcp.js');
const { storageDir } = await import('../src/host/store.js');

async function startMcp(service, token) {
  const handler = createInboxMcpHandler(service, { getToken: () => token });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (body, headers = {}) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text === '' ? null : JSON.parse(text) };
  };
  return { base, post, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function makeService() {
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  return { ctx, service };
}

const TOKEN = 'test-token-0123456789abcdef';

test('mcp: initialize echoes protocol version and describes the server', async () => {
  const home = tempHome();
  const { ctx, service } = await makeService();
  const mcp = await startMcp(service, TOKEN);
  try {
    const { status, json } = await mcp.post(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { authorization: 'Bearer ' + TOKEN },
    );
    assert.equal(status, 200);
    assert.equal(json.result.protocolVersion, '2025-06-18');
    assert.equal(json.result.serverInfo.name, 'droplets-inbox');
    assert.ok(json.result.capabilities.tools);
    assert.ok(typeof json.result.instructions === 'string');
  } finally {
    await mcp.close();
    await ctx.dispose();
    home.cleanup();
  }
});

test('mcp: tools/list carries the five inbox tools; tools/call lists and marks', async () => {
  const home = tempHome();
  const { ctx, service } = await makeService();
  const mcp = await startMcp(service, TOKEN);
  try {
    const auth = { authorization: 'Bearer ' + TOKEN };
    const listed = await mcp.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    assert.equal(listed.status, 200);
    const names = listed.json.result.tools.map((tool) => tool.name);
    assert.deepEqual([...names].sort(), ['inbox_add_url', 'inbox_list', 'inbox_mark_done', 'inbox_read', 'inbox_update']);
    for (const tool of listed.json.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
    }

    // Empty inbox: the tool reports it as text, not as an error.
    const empty = await mcp.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inbox_list', arguments: { filter: 'unread' } } }, auth);
    assert.equal(empty.json.result.isError, undefined);
    assert.match(empty.json.result.content[0].text, /没有条目/);

    // A bad tool argument is an isError result, not a transport failure.
    const bad = await mcp.post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'inbox_read', arguments: {} } }, auth);
    assert.equal(bad.json.result.isError, true);
    assert.match(bad.json.result.content[0].text, /inbox_read 需要 key/);

    // Unknown method answers -32601.
    const unknown = await mcp.post({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, auth);
    assert.equal(unknown.json.error.code, -32601);

    // Pure notifications get 202 with no body.
    const response = await fetch(mcp.base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(response.status, 202);
  } finally {
    await mcp.close();
    await ctx.dispose();
    home.cleanup();
  }
});

test('mcp: auth rejects wrong or missing tokens; GET and DELETE are 405', async () => {
  const home = tempHome();
  const { ctx, service } = await makeService();
  const mcp = await startMcp(service, TOKEN);
  try {
    const wrong = await mcp.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    const missing = await mcp.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(missing.status, 401);

    const get = await fetch(mcp.base, { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(get.status, 405);
    const del = await fetch(mcp.base, { method: 'DELETE', headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(del.status, 405);
  } finally {
    await mcp.close();
    await ctx.dispose();
    home.cleanup();
  }
});

test('mcp: inbox_add_url captures and mark_done files the item', async () => {
  const home = tempHome();
  const { ctx, service } = await makeService();
  const mcp = await startMcp(service, TOKEN);
  try {
    const auth = { authorization: 'Bearer ' + TOKEN };
    // An invalid URL is an argument error the agent can see and correct.
    const bad = await mcp.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inbox_add_url', arguments: { url: 'ftp://example.com' } } }, auth);
    assert.equal(bad.json.result.isError, true);

    // Markdown import through the service gives the queue an item to finish.
    const { item } = await service.inboxImportMarkdown({ filename: 'note.md', content: '# Captured\n\nBody text.' });
    const listed = await mcp.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inbox_list', arguments: { filter: 'unread' } } }, auth);
    assert.match(listed.json.result.content[0].text, new RegExp(item.id));

    const read = await mcp.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inbox_read', arguments: { key: item.id } } }, auth);
    assert.match(read.json.result.content[0].text, /Captured/);

    const tags = await mcp.post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'inbox_update', arguments: { key: item.id, tags: ['triage', 'keep'] } } }, auth);
    assert.match(tags.json.result.content[0].text, /triage, keep/);

    const done = await mcp.post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'inbox_mark_done', arguments: { key: item.id, action: 'trash' } } }, auth);
    assert.equal(done.json.result.isError, undefined);
    const after = await service.inboxList({ status: 'unread' });
    assert.equal(after.items.length, 0, 'item left the unread queue');
  } finally {
    await mcp.close();
    await ctx.dispose();
    home.cleanup();
  }
});

test('mcp: token sidecar is created once and rotation mints a new one', async () => {
  const home = tempHome();
  try {
    const first = await loadOrCreateMcpToken(storageDir());
    assert.ok(first.token.length >= 16);
    const again = await loadOrCreateMcpToken(storageDir());
    assert.equal(again.token, first.token, 'idempotent while the file exists');
    const rotated = await rotateMcpToken(storageDir());
    assert.notEqual(rotated.token, first.token);
    const afterRotate = await loadOrCreateMcpToken(storageDir());
    assert.equal(afterRotate.token, rotated.token);
  } finally {
    home.cleanup();
  }
});

test('mcp: malformed JSON answers -32700 and the endpoint path is stable', async () => {
  assert.equal(inboxMcpPath(), '/droplets-inbox/mcp');
  assert.equal(inboxMcpTools().length, 5);
  const home = tempHome();
  const { ctx, service } = await makeService();
  const mcp = await startMcp(service, TOKEN);
  try {
    const response = await fetch(mcp.base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: 'not json at all',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, -32700);
  } finally {
    await mcp.close();
    await ctx.dispose();
    home.cleanup();
  }
});
