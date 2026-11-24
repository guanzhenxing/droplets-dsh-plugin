import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tempHome, fakeCtx } from './helpers.mjs';

const { Vault, normalizeAttachmentPath } = await import('../src/host/vault.js');

function tempVault() {
  const root = mkdtempSync(path.join(tmpdir(), 'dpl-vault-'));
  const holder = { value: { path: root, builtAt: Date.now(), files: {} }, set(next) { this.value = next; }, touch() {} };
  return { root, vault: new Vault(root, holder, console), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 1×1 PNG (magic bytes + IHDR), enough for the sniffer. */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082',
  'hex',
);
const GIF_BYTES = Buffer.from('47494638396101000100800000000000', 'hex');

test('normalizeAttachmentPath: same traversal rules, any extension', () => {
  assert.equal(normalizeAttachmentPath('attachments/a.png'), 'attachments/a.png');
  assert.equal(normalizeAttachmentPath('/x/./y/z.jpg'), 'x/y/z.jpg');
  assert.throws(() => normalizeAttachmentPath('../escape.png'), (e) => e.code === 'path_escape');
  assert.throws(() => normalizeAttachmentPath('a/../../b.png'), (e) => e.code === 'path_escape');
  assert.throws(() => normalizeAttachmentPath('.git/x.png'), (e) => e.code === 'excluded_path');
  assert.throws(() => normalizeAttachmentPath(''), (e) => e.code === 'invalid_path');
});

test('writeAttachment stores magic-validated images under attachments/ with dedupe', async () => {
  const { root, vault, cleanup } = tempVault();
  try {
    const first = await vault.writeAttachment(PNG_BYTES, { name: '屏幕快照.png' });
    assert.equal(first.path, 'attachments/屏幕快照.png');
    assert.equal(first.mime, 'image/png');
    // Same name again → deduped, original untouched.
    const second = await vault.writeAttachment(PNG_BYTES, { name: '屏幕快照.png' });
    assert.equal(second.path, 'attachments/屏幕快照-1.png');
    // Name traversal and unsafe characters are sanitized away.
    const third = await vault.writeAttachment(GIF_BYTES, { name: '../../evil name.gif' });
    assert.ok(third.path.startsWith('attachments/'), third.path);
    assert.ok(!third.path.includes('..'));
    // Non-image bytes are rejected outright.
    await assert.rejects(vault.writeAttachment(Buffer.from('<html>not an image</html>'), { name: 'x.png' }), (e) => e.code === 'invalid_attachment');
    // Explicit dir override works.
    const nested = await vault.writeAttachment(PNG_BYTES, { name: 'pic', dir: '2-Areas/图' });
    assert.equal(nested.path, '2-Areas/图/pic.png');
    // Attachments never enter the markdown index.
    assert.equal(readFileSync(path.join(root, 'attachments/屏幕快照.png')).length, PNG_BYTES.length);
  } finally { cleanup(); }
});

test('readAttachment serves data URLs and refuses bad paths', async () => {
  const { root, vault, cleanup } = tempVault();
  try {
    await vault.writeAttachment(PNG_BYTES, { name: 'a' });
    mkdirSync(path.join(root, '2-Areas'), { recursive: true });
    writeFileSync(path.join(root, '2-Areas/note.md'), 'x', 'utf8');
    const read = await vault.readAttachment('attachments/a.png');
    assert.equal(read.mime, 'image/png');
    assert.ok(read.dataUrl.startsWith('data:image/png;base64,'));
    assert.ok(read.dataUrl.endsWith(PNG_BYTES.toString('base64')));
    await assert.rejects(vault.readAttachment('attachments/missing.png'), (e) => e.code === 'not_found');
    await assert.rejects(vault.readAttachment('../outside.png'), (e) => e.code === 'path_escape');
    // A markdown note is not an image.
    await assert.rejects(vault.readAttachment('2-Areas/note.md'), (e) => e.code === 'invalid_attachment');
  } finally { cleanup(); }
});

test('service: vaultWriteAttachment / vaultReadAttachment round trip', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const { DropletsService } = await import('../src/host/index.js');
  const service = new DropletsService(ctx, {});
  await service.ready;
  try {
    const stored = await service.vaultWriteAttachment({ bytes: PNG_BYTES.toString('base64'), name: 'pasted' });
    assert.equal(stored.path, 'attachments/pasted.png');
    const read = await service.vaultReadAttachment({ path: stored.path });
    assert.equal(read.mime, 'image/png');
    assert.ok(read.dataUrl.startsWith('data:image/png;base64,'));
    await assert.rejects(service.vaultWriteAttachment({ bytes: Buffer.from('nope').toString('base64') }), /图片/);
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});
