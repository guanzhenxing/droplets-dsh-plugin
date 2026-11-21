import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeChatBridge } from '../src/client/native-chat.js';

function makeScope(overrides = {}) {
  const listeners = new Set();
  const state = { draft: '', phase: 'plain', attachmentIds: [] };
  let submits = 0;
  let released = false;
  const input = {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const emit = () => { for (const fn of listeners) fn(); };
  const scope = {
    sessions: {
      async create(request) { assert.equal(request.workspaceId, 'w'); return 's1'; },
      retain(id) { return { sessionId: id, release() { released = true; } }; },
    },
    uiWorkspace: {
      workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w', path: '/x/default-workspace' }] }) } },
    },
    uiSession: {
      bindingSource() {
        return {
          value: {
            hooks: { input },
            props: {
              inputActions: {
                setDraft(text) { state.draft = text; emit(); },
                submit() { submits += 1; state.draft = ''; emit(); },
                captureInsertion() { return { rev: 1 }; },
                insertText(text) { state.draft = text; emit(); return true; },
              },
            },
          },
        };
      },
    },
    ...overrides,
  };
  return { scope, state, input, getSubmits: () => submits, isReleased: () => released };
}

test('bridge opens the default workspace, sends, and releases', async () => {
  const harness = makeScope();
  let cleanupScope;
  const bridge = nativeChatBridge({ inject(names, cb) { cleanupScope = cb(harness.scope); } });
  assert.equal(bridge.defaultChatWorkspace(), 'w');
  const chat = await bridge.openChat({ workspaceId: 'w' });
  assert.equal(harness.state.draft, '', 'opening leaves the composer untouched');
  await chat.submitPrompt('概括要点');
  assert.equal(harness.getSubmits(), 1);
  chat.release();
  assert.ok(harness.isReleased());
  cleanupScope();
  assert.equal(bridge.defaultChatWorkspace(), undefined, 'scope cleared on dispose');
});

test('guards throw on drafts, attachments and busy phases instead of skipping', async () => {
  const harness = makeScope();
  let cleanupScope;
  const bridge = nativeChatBridge({ inject(names, cb) { cleanupScope = cb(harness.scope); } });
  const chat = await bridge.openChat({ workspaceId: 'w' });

  harness.state.draft = '用户未发送的草稿';
  await assert.rejects(chat.submitPrompt('new prompt'), /已有草稿/);
  assert.equal(harness.getSubmits(), 0, 'nothing submitted on guard failure');
  harness.state.draft = '';

  harness.state.attachmentIds = ['att-1'];
  await assert.rejects(chat.submitPrompt('new prompt'), /附件/);
  harness.state.attachmentIds = [];

  harness.state.phase = 'streaming';
  await assert.rejects(chat.submitPrompt('new prompt'), /处理消息/);
  harness.state.phase = 'plain';
  cleanupScope();
});

test('1200ms draft-sync failure degrades to a manual-send error', async () => {
  const harness = makeScope();
  // A setDraft that never notifies and never applies.
  harness.scope.uiSession.bindingSource = () => ({
    value: {
      hooks: { input: harness.input },
      props: { inputActions: { setDraft() {}, submit() {} } },
    },
  });
  let cleanupScope;
  const bridge = nativeChatBridge({ inject(names, cb) { cleanupScope = cb(harness.scope); } });
  const chat = await bridge.openChat({ workspaceId: 'w' });
  await assert.rejects(chat.submitPrompt('slow draft'), /手动发送/);
  cleanupScope();
});

test('capability check rejects hosts without the draft API', async () => {
  const harness = makeScope();
  harness.scope.uiSession.bindingSource = () => ({ value: { props: {}, hooks: {} } });
  let cleanupScope;
  const bridge = nativeChatBridge({ inject(names, cb) { cleanupScope = cb(harness.scope); } });
  await assert.rejects(bridge.openChat({ workspaceId: 'w' }), /不支持原生伴读/);
  assert.ok(harness.isReleased(), 'reference released on the error path');
  cleanupScope();
});
