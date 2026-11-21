/** Retain Harness sessions for an embedded companion conversation without changing navigation. */
export function nativeChatBridge(ctx) {
  let scope;
  const watchers = new Set();
  ctx.inject(['sessions', 'uiSession', 'uiWorkspace'], (child) => {
    scope = child;
    for (const notify of watchers) notify();
    return () => { scope = undefined; for (const notify of watchers) notify(); };
  });
  return {
    defaultChatWorkspace() {
      const items = scope?.uiWorkspace.workspaces.list.getSnapshot().items ?? [];
      const preferred = items.find((w) => w.title === 'default-workspace' || /(?:^|\/)default-workspace$/.test(w.path || ''));
      return (preferred ?? items[0])?.workspaceId;
    },
    watchChatWorkspaces(listener) {
      watchers.add(listener);
      const unsubscribe = scope?.uiWorkspace.workspaces.list.subscribe(listener) ?? (() => {});
      return () => { watchers.delete(listener); unsubscribe(); };
    },
    chatWorkspaces() {
      return scope?.uiWorkspace.workspaces.list.getSnapshot().items.map((w) => ({ id: w.workspaceId, name: w.title || w.name || w.path, path: w.path })) ?? [];
    },
    async openChat({ workspaceId, sessionId }) {
      if (!scope) throw new Error('Harness 对话服务尚未就绪');
      const active = scope;
      if (!active.uiWorkspace.workspaces.list.getSnapshot().items.some((w) => w.workspaceId === workspaceId)) throw new Error('请选择工作区');
      const id = sessionId || await active.sessions.create({ workspaceId });
      const reference = active.sessions.retain(id, { source: 'droplets' });
      try {
        const source = active.uiSession.bindingSource(reference);
        const actions = source.value.props.inputActions;
        const input = source.value.hooks?.input;
        if (typeof actions?.setDraft !== 'function' || typeof actions.submit !== 'function' || typeof input?.getSnapshot !== 'function' || typeof input?.subscribe !== 'function') {
          throw new Error('当前 Harness 版本不支持原生伴读');
        }
        const ensurePlain = (allowedDraft = '') => {
          const state = input.getSnapshot();
          if (state.phase !== 'plain') throw new Error('当前输入框正在处理消息，请稍后重试');
          if (state.attachmentIds?.length) throw new Error('输入框有待发送附件，请先处理附件');
          if (state.draft.trim() && state.draft.trim() !== allowedDraft.trim()) throw new Error('输入框已有草稿，请先发送或清空草稿');
        };
        const setPrompt = async (prompt, allowedDraft = '') => {
          ensurePlain(allowedDraft);
          actions.setDraft(prompt);
          if (input.getSnapshot().draft !== prompt) await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { unsubscribe(); reject(new Error('提示词已放入输入框，请手动发送')); }, 1200);
            const unsubscribe = input.subscribe(() => {
              if (input.getSnapshot().draft === prompt) { clearTimeout(timeout); unsubscribe(); resolve(); }
            });
            if (input.getSnapshot().draft === prompt) { clearTimeout(timeout); unsubscribe(); resolve(); }
          });
        };
        return {
          sessionId: id,
          reference,
          release: () => reference.release(),
          watchAnswer(listener) {
            const conversation = source.value.hooks?.conversation;
            if (!conversation?.subscribe) return () => {};
            const read = () => listener(conversation.getSnapshot());
            read();
            return conversation.subscribe(read);
          },
          setDraft: setPrompt,
          insertContext(prompt) {
            if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') throw new Error('当前 Harness 版本不支持插入引用');
            const span = actions.captureInsertion();
            if (!actions.insertText(`${prompt}\n\n`, span)) throw new Error('输入框正在发送，请稍后重试');
          },
          async submitPrompt(prompt, allowedDraft = '') {
            await setPrompt(prompt, allowedDraft);
            if (input.getSnapshot().phase !== 'plain') throw new Error('输入框正在处理消息');
            actions.submit();
          },
        };
      } catch (error) {
        reference.release();
        throw error;
      }
    },
  };
}
