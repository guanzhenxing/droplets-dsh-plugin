import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  Vault, normalizeVaultPath, safeResolve, walkVault, parseFrontmatter,
  extractWikilinks, extractTags, recordOf, ensureDefaultVault, VaultError,
} from '../src/host/vault.js';

function tempVault() {
  const root = mkdtempSync(path.join(tmpdir(), 'dpl-vault-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(root, rel, content) {
  const target = path.join(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

test('normalizeVaultPath rejects escape, hidden and non-markdown paths', () => {
  assert.equal(normalizeVaultPath('a/b.md'), 'a/b.md');
  assert.equal(normalizeVaultPath('/x/./y.md'), 'x/y.md');
  assert.throws(() => normalizeVaultPath('../escape.md'), (e) => e.code === 'path_escape');
  assert.throws(() => normalizeVaultPath('a/b.txt'), (e) => e.code === 'not_markdown');
  assert.throws(() => normalizeVaultPath(''), (e) => e.code === 'invalid_path');
});

test('safeResolve rejects symlinks and escapes', async () => {
  const { root, cleanup } = tempVault();
  write(root, 'real.md', 'x');
  symlinkSync(path.join(root, 'real.md'), path.join(root, 'link.md'));
  await assert.rejects(safeResolve(root, 'link.md'), (e) => e.code === 'symlink_rejected');
  await assert.rejects(safeResolve(root, '../outside.md'), (e) => e.code === 'path_escape');
  const ok = await safeResolve(root, 'real.md');
  const { realpathSync } = await import('node:fs');
  assert.equal(ok, path.join(realpathSync(root), 'real.md'));
  const fresh = await safeResolve(root, 'new/note.md');
  assert.equal(fresh, path.join(realpathSync(root), 'new/note.md'));
  cleanup();
});

test('walkVault indexes only markdown, skipping excluded dirs', async () => {
  const { root, cleanup } = tempVault();
  write(root, 'a.md', 'x');
  write(root, 'sub/b.md', 'x');
  write(root, '.obsidian/config.json', 'x');
  write(root, '.trash/c.md', 'x');
  write(root, '.hidden/d.md', 'x');
  write(root, 'e.txt', 'x');
  const files = await walkVault(root);
  assert.deepEqual(files.sort(), ['a.md', 'sub/b.md']);
  cleanup();
});

test('frontmatter, wikilinks and tags extraction', () => {
  const text = '---\ntitle: My Note\ntags:\n  - reading\n  - ai\nsource: https://x.example\n---\n' +
    '# Heading body\nSee [[other note|Other]] and [[deep/note#sec]]. Tag #inbox one #reading/x.\n';
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.title, 'My Note');
  assert.deepEqual(data.tags, ['reading', 'ai']);
  const links = extractWikilinks(body);
  assert.equal(links.length, 2);
  assert.equal(links[0].target, 'other note');
  assert.equal(links[0].raw, '[[other note|Other]]');
  assert.equal(links[1].target, 'deep/note');
  assert.equal(links[1].heading, 'sec');
  const tags = extractTags(body);
  assert.ok(tags.includes('inbox'));
  assert.ok(tags.includes('reading/x'));
});

test('index invalidation: mtime/size spot-check re-reads changed files', async () => {
  const { root, cleanup } = tempVault();
  write(root, 'note.md', '# One\nbody one');
  let holderValue = null;
  const holder = {
    get: () => holderValue,
    set: (value) => { holderValue = value; },
    touch: () => {},
  };
  const vault = new Vault(root, holder);
  const first = await vault.reindex();
  assert.equal(first.files, 1);
  assert.equal(holderValue.files['note.md'].title, 'One');

  write(root, 'note.md', '# Two\nbody two');
  // Same size different content: mtime drives invalidation.
  const record = await import('../src/host/vault.js').then((m) => m.indexFile(root, 'note.md', holderValue.files['note.md']));
  assert.equal(record.title, 'Two');
  cleanup();
});

test('search ranks title/tag hits and scans bodies; write conflict surfaces current sha', async () => {
  const { root, cleanup } = tempVault();
  write(root, 'alpha.md', '---\ntitle: Alpha Note\ntags: [reading]\n---\nunique alpha content');
  write(root, 'beta.md', '# Beta\nmentions alpha content inside body');
  let holderValue = null;
  const holder = { get: () => holderValue, set: (v) => { holderValue = v; }, touch: () => {} };
  const vault = new Vault(root, holder);
  await vault.reindex();

  const byTitle = await vault.search('alpha');
  assert.equal(byTitle[0].path, 'alpha.md');
  assert.equal(byTitle[0].match, 'title/tag');
  const byBody = await vault.search('beta');
  assert.equal(byBody[0].path, 'beta.md');

  const read1 = await vault.read('alpha.md');
  // External edit under the vault's feet.
  write(root, 'alpha.md', '---\ntitle: Alpha Changed\n---\nnew content');
  const conflict = await vault.write('alpha.md', 'replacement', { expectedSha: read1.sha });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.currentSha.length, 64);
  assert.ok(conflict.currentExcerpt.includes('Alpha Changed'));
  const ok = await vault.write('alpha.md', 'replacement', { expectedSha: conflict.currentSha });
  assert.equal(ok.conflict, false);
  assert.equal(ok.created, false);
  const created = await vault.write('gamma.md', '# Gamma', {});
  assert.equal(created.created, true);
  cleanup();
});

test('backlinks resolve through the index; graph adds dangling nodes', async () => {
  const { root, cleanup } = tempVault();
  write(root, 'a.md', 'links to [[b]]');
  write(root, 'b.md', '# B');
  write(root, 'c.md', 'points at [[missing note]]');
  let holderValue = null;
  const holder = { get: () => holderValue, set: (v) => { holderValue = v; }, touch: () => {} };
  const vault = new Vault(root, holder);
  await vault.reindex();
  const links = vault.backlinks('b.md');
  assert.equal(links.length, 1);
  assert.equal(links[0].path, 'a.md');
  const graph = vault.graph();
  assert.equal(graph.nodes.filter((node) => node.dangling).length, 1);
  assert.ok(graph.edges.some((edge) => edge.source === 'c.md' && edge.target.startsWith('dangling:')));
  cleanup();
});

test('ensureDefaultVault creates the PARA skeleton', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dpl-default-'));
  await ensureDefaultVault(root);
  const { statSync } = await import('node:fs');
  for (const folder of ['0-Inbox', '1-Projects', '2-Areas', '3-Resources', '4-Archives']) {
    assert.ok(statSync(path.join(root, folder)).isDirectory(), folder);
  }
  rmSync(root, { recursive: true, force: true });
});
