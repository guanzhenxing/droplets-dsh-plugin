import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vault, ensureDefaultVault } from '../src/host/vault.js';

const quietLogger = { info() {}, warn() {}, error() {} };

function tempVault() {
  const dir = mkdtempSync(path.join(tmpdir(), 'droplets-vault-p0-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 }),
  };
}

function makeVault(dir) {
  const cache = { current: { path: dir, builtAt: 0, files: {} } };
  const holder = {
    get: () => cache.current,
    set: (value) => { cache.current = value; },
    touch: () => {},
  };
  return new Vault(dir, holder, quietLogger);
}

// ---- pure logic: ancestorsOf (client parity) ----
test('ancestorsOf derives dir chain from a note path', () => {
  const fn = (p) => {
    const segments = String(p ?? '').split('/');
    const dirs = [];
    for (let i = 1; i <= segments.length - 1; i += 1) dirs.push(segments.slice(0, i).join('/'));
    return dirs;
  };
  assert.deepEqual(fn('a/b/c.md'), ['a', 'a/b']); // bounds fixed in client
  assert.deepEqual(fn('root.md'), []);
  assert.deepEqual(fn('x/y/z/w.md'), ['x', 'x/y', 'x/y/z']);
});

test('filterFiles ranks exact > prefix > substring with a cap', () => {
  const files = [
    { path: 'a/终端配置指南.md', name: '终端配置指南.md' },
    { path: 'b/终端.md', name: '终端.md' },
    { path: 'c/使用终端的技巧.md', name: '使用终端的技巧.md' },
    { path: 'd/无关.md', name: '无关.md' },
  ];
  const fn = (all, query, limit = 40) => {
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle === '') return [];
    const ranked = [];
    for (const file of all) {
      const name = file.name.toLowerCase();
      if (name === needle) ranked.push({ file, score: 0 });
      else if (name.startsWith(needle)) ranked.push({ file, score: 1 });
      else if (name.includes(needle)) ranked.push({ file, score: 2 });
    }
    ranked.sort((a, b) => a.score - b.score || a.file.name.localeCompare(b.file.name));
    return ranked.slice(0, limit).map((hit) => hit.file);
  };
  const hits = fn(files, '终端');
  assert.equal(hits[0].name, '终端.md'); // exact first
  assert.equal(hits[1].name, '终端配置指南.md'); // then prefix
  assert.equal(hits[2].name, '使用终端的技巧.md'); // then substring
  assert.ok(!hits.some((hit) => hit.name === '无关.md'));
  assert.equal(fn(files, '').length, 0);
  assert.equal(fn(files, '终端', 2).length, 2);
});

// ---- vault.list: lazy listing with dirs-first ----
test('vault.list returns dirs-first entries including empty dirs', async () => {
  const vault_dir = tempVault();
  try {
    mkdirSync(path.join(vault_dir.dir, '0-Drafts'));
    mkdirSync(path.join(vault_dir.dir, '3-Resources', '子目录'), { recursive: true });
    writeFileSync(path.join(vault_dir.dir, 'note.md'), '# 笔记\n');
    writeFileSync(path.join(vault_dir.dir, '0-Drafts', 'inbox-note.md'), 'x');
    writeFileSync(path.join(vault_dir.dir, '.hidden.md'), 'x');
    writeFileSync(path.join(vault_dir.dir, 'skip.txt'), 'x');
    const vault = makeVault(vault_dir.dir);
    const root = await vault.list('');
    assert.deepEqual(root.entries.map((e) => e.kind + ':' + e.name), ['dir:0-Drafts', 'dir:3-Resources', 'file:note.md']);
    const drafts = await vault.list('0-Drafts');
    assert.equal(drafts.entries.length, 1);
    assert.equal(drafts.entries[0].title, 'inbox-note');
    const nested = await vault.list('3-Resources/子目录');
    assert.equal(nested.entries.length, 0); // empty dir still listed
    await assert.rejects(() => vault.list('不存在'), /目录不存在/);
  } finally { vault_dir.cleanup(); }
});

// ---- createNote with native frontmatter ----
test('vault.createNote writes native-shape frontmatter and refuses duplicates', async () => {
  const v = tempVault();
  try {
    const vault = makeVault(v.dir);
    const created = await vault.createNote('', '我的笔记');
    assert.equal(created.path, '我的笔记.md');
    const text = readFileSync(path.join(v.dir, '我的笔记.md'), 'utf8');
    assert.match(text, /^---\nid: [0-9a-f-]{36}\ntitle: 我的笔记\ncreated: /);
    assert.ok(text.includes('# 我的笔记'));
    await assert.rejects(() => vault.createNote('', '我的笔记'), /笔记已存在/);
  } finally { v.cleanup(); }
});

// ---- rename with wikilink rewrite + rollback safety ----
test('vault.renameNote moves the file and rewrites inbound wikilinks', async () => {
  const v = tempVault();
  try {
    writeFileSync(path.join(v.dir, 'target.md'), '# 目标\n');
    writeFileSync(path.join(v.dir, 'linker.md'), '见 [[target]] 与 [[target|别名]]。\n');
    writeFileSync(path.join(v.dir, 'unrelated.md'), '[[别的]]\n');
    const vault = makeVault(v.dir);
    await vault.reindex();
    const result = await vault.renameNote('target.md', 'renamed.md', { updateLinks: true });
    assert.equal(result.path, 'renamed.md');
    assert.equal(result.updatedLinks, 1);
    assert.equal(readFileSync(path.join(v.dir, 'renamed.md'), 'utf8'), '# 目标\n');
    const linker = readFileSync(path.join(v.dir, 'linker.md'), 'utf8');
    assert.ok(linker.includes('[[renamed]]'), 'plain link rewritten');
    assert.ok(linker.includes('[[renamed|别名]]'), 'aliased link rewritten');
    assert.equal(readFileSync(path.join(v.dir, 'unrelated.md'), 'utf8'), '[[别的]]\n');
    assert.equal(existsSync(path.join(v.dir, 'target.md')), false);
    // cache moved the record
    assert.ok(vault.cache().files['renamed.md']);
    assert.equal(vault.cache().files['target.md'], undefined);
  } finally { v.cleanup(); }
});

test('vault.renameNote refuses collisions', async () => {
  const v = tempVault();
  try {
    writeFileSync(path.join(v.dir, 'a.md'), 'A');
    writeFileSync(path.join(v.dir, 'b.md'), 'B');
    const vault = makeVault(v.dir);
    await vault.reindex();
    await assert.rejects(() => vault.renameNote('a.md', 'b.md'), /目标已存在/);
    assert.equal(readFileSync(path.join(v.dir, 'a.md'), 'utf8'), 'A');
  } finally { v.cleanup(); }
});

// ---- duplicate ----
test('vault.duplicate creates 「x 副本」 with increment', async () => {
  const v = tempVault();
  try {
    writeFileSync(path.join(v.dir, 'doc.md'), '# D\n');
    const vault = makeVault(v.dir);
    await vault.reindex();
    const first = await vault.duplicate('doc.md');
    assert.equal(first.path, 'doc 副本.md');
    const second = await vault.duplicate('doc.md');
    assert.equal(second.path, 'doc 副本 2.md');
    assert.equal(readFileSync(path.join(v.dir, 'doc 副本.md'), 'utf8'), '# D\n');
  } finally { v.cleanup(); }
});

// ---- trash: staging commit shape (Droplets-recoverable) ----
test('vault.trash stages payload + meta then commits', async () => {
  const v = tempVault();
  try {
    writeFileSync(path.join(v.dir, 'gone.md'), '# 再见\n');
    const vault = makeVault(v.dir);
    await vault.reindex();
    const result = await vault.trash('gone.md');
    assert.equal(result.trashed, true);
    assert.equal(existsSync(path.join(v.dir, 'gone.md')), false);
    const trashId = result.trashId;
    const meta = JSON.parse(readFileSync(path.join(v.dir, '.trash', trashId, 'trash-meta.json'), 'utf8'));
    assert.equal(meta.deletedFrom, 'vault');
    assert.equal(meta.entryKind, 'file');
    // Title prefers the indexed human title (# 再见) over the filename stem.
    assert.equal(meta.title, '再见');
    // A file payload IS the file itself (renamed in whole, not nested).
    assert.equal(readFileSync(path.join(v.dir, '.trash', trashId, 'payload'), 'utf8'), '# 再见\n');
    assert.equal(existsSync(path.join(v.dir, '.trash', '.staging-anything')), false);
    // folder trash
    mkdirSync(path.join(v.dir, 'folder'), { recursive: true });
    writeFileSync(path.join(v.dir, 'folder', 'inner.md'), 'x');
    const folderResult = await vault.trash('folder');
    assert.equal(folderResult.entryKind ?? 'dir', 'dir');
    assert.equal(existsSync(path.join(v.dir, 'folder')), false);
  } finally { v.cleanup(); }
});

test('vault.trash refuses the vault root', async () => {
  const v = tempVault();
  const vault = makeVault(v.dir);
  await assert.rejects(() => vault.trash(''), /vault 根/);
  v.cleanup();
});

// ---- normalizeVaultDir guards ----
test('dir normalization rejects escapes and excluded dirs', async () => {
  const v = tempVault();
  const vault = makeVault(v.dir);
  await assert.rejects(() => vault.list('../outside'), /不允许 \.\./);
  await assert.rejects(() => vault.createDir('.obsidian/x'), /不在索引范围/);
  await assert.rejects(() => vault.createDir(''), /目录名不能为空/);
  v.cleanup();
});

// ---- P3: graph neighborhood slicing (client parity, pure) ----
test('neighborhoodOf keeps center + hops; capByDegree keeps hubs', () => {
  const fn = (graph, center, depth, limit) => {
    const adjacency = new Map();
    for (const edge of graph.edges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
      adjacency.get(edge.source).push(edge.target);
      adjacency.get(edge.target).push(edge.source);
    }
    const keep = new Set([center]);
    let frontier = [center];
    for (let hop = 0; hop < depth; hop += 1) {
      const next = [];
      for (const node of frontier) {
        for (const neighbor of adjacency.get(node) ?? []) {
          if (!keep.has(neighbor)) { keep.add(neighbor); next.push(neighbor); }
        }
      }
      frontier = next;
      if (keep.size >= limit) break;
    }
    const nodes = graph.nodes.filter((node) => keep.has(node.id)).slice(0, limit);
    const kept = new Set(nodes.map((node) => node.id));
    return { nodes, edges: graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)) };
  };
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'd' }],
  };
  const local = fn(graph, 'a', 2, 300);
  assert.deepEqual(local.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.equal(local.edges.length, 2);
  const whole = fn(graph, 'a', 5, 300);
  assert.equal(whole.nodes.length, 4);
});
