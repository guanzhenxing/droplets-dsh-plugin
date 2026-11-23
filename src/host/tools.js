/**
 * Agent-facing tools. Three multi-action tools mirror the three spaces; the
 * model reaches the same service implementations the panel uses. vault_write
 * always carries expected_sha — a mismatch returns a structured conflict with
 * the current sha and an excerpt so the agent re-reads before writing again.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

function text(value) {
  return [{ type: 'text', text: value }];
}

function renderJson(_args, value) {
  return text(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function formatEntryLine(entry) {
  const flags = [entry.read ? null : '未读', entry.favorite ? '收藏' : null].filter(Boolean).join(',');
  const channel = entry.channelName ? ` [${entry.channelName}]` : '';
  const date = entry.publishedAt ? ` (${entry.publishedAt.slice(0, 10)})` : '';
  return `- ${entry.key} | ${entry.title}${channel}${date}${flags ? ` ${flags}` : ''}`;
}

const INBOX_ADD_TIMEOUT_NOTE = 'add_url 会真实抓取远程内容(首字节 20s / 总 60s / 50MB 上限),大文件可能接近超时。';

export function createToolDefinitions(service) {
  return [

    // ---------------------------------------------------------------- droplets_feed
    defineTool({
      name: 'droplets_feed',
      description: 'Droplets 信息流:管理 RSS/Atom/JSON Feed 订阅、列出与阅读条目、搜索、刷新。用户提到订阅、信息流、RSS、看文章时用它。',
      parameters: {
        action: {
          type: 'string',
          enum: ['list_channels', 'list_articles', 'read', 'search', 'add_subscription', 'refresh'],
          description: 'list_channels 列源;list_articles 列条目;read 读正文;search 搜标题;add_subscription 加订阅;refresh 刷新。',
          required: true,
        },
        channel: { type: 'string', description: '源 key(list_channels 返回);list_articles/read/refresh 可用,省略为全部。' },
        filter: { type: 'string', description: 'list_articles 的过滤:all | unread | favorite。' },
        search: { type: 'string', description: 'list_articles 的标题子串过滤。' },
        key: { type: 'string', description: 'read 的条目 key(list_articles 返回)。' },
        query: { type: 'string', description: 'search 的搜索词。' },
        limit: { type: 'number', description: '返回上限(默认 20)。' },
        url: { type: 'string', description: 'add_subscription 的订阅地址 (http/https)。' },
        name: { type: 'string', description: 'add_subscription 的显示名(可选)。' },
        group: { type: 'string', description: 'add_subscription 的分组(可选)。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      execute: async (args) => {
        switch (args?.action) {
          case 'list_channels': {
            const { channels } = await service.listChannels();
            if (channels.length === 0) return '还没有订阅。用 add_subscription 添加,或 refresh 刷新。';
            const lines = channels.map((channel) => `- ${channel.key} | ${channel.name}${channel.group ? ` (${channel.group})` : ''} | ${channel.kind} | 未读 ${channel.unread}/${channel.total}${channel.lastError ? ' | 上次失败' : ''}`);
            return `源列表:\n${lines.join('\n')}`;
          }
          case 'list_articles': {
            const page = await service.listEntries({ channel: args.channel, filter: args.filter, search: args.search, limit: Math.min(args.limit ?? 20, 50) });
            if (page.entries.length === 0) return '没有匹配的条目。试试 refresh 或换个过滤。';
            return [`条目 (${page.entries.length}${page.hasMore ? '+,还有更多' : ''}):`, ...page.entries.map(formatEntryLine)].join('\n');
          }
          case 'read': {
            if (typeof args?.key !== 'string' || args.key === '') throw new Error('read 需要 key(list_articles 返回)');
            const { entry, html, truncated } = await service.getEntry({ key: args.key });
            const { htmlToText } = await import('./sanitize.js');
            const header = [
              `# ${entry.title}`,
              '',
              entry.url ? `原文链接: ${entry.url}` : null,
              entry.channelName ? `来源: ${entry.channelName}` : null,
              entry.author ? `作者: ${entry.author}` : null,
              entry.publishedAt ? `发布时间: ${entry.publishedAt}` : null,
              truncated ? '(正文过长已截断)' : null,
              '',
            ].filter((line) => line !== null).join('\n');
            const body = htmlToText(html, 40_000);
            return body === '' ? `${header}(这篇条目没有正文,请打开原文阅读)` : `${header}\n${body}`;
          }
          case 'search': {
            if (typeof args?.query !== 'string' || args.query.trim() === '') throw new Error('search 需要 query');
            const results = await service.searchEntries({ query: args.query, limit: Math.min(args.limit ?? 20, 50) });
            if (results.length === 0) return `没有标题匹配「${args.query}」的缓存条目。`;
            return `结果:\n${results.map(formatEntryLine).join('\n')}`;
          }
          case 'add_subscription': {
            if (typeof args?.url !== 'string' || !/^https?:\/\//i.test(args.url)) throw new Error('add_subscription 需要 http(s) url');
            const result = await service.addSubscription({ url: args.url, name: args.name, group: args.group });
            return `已订阅「${result.name}」(${result.id}),${result.entryCount} 条种子条目${result.status === 'error' ? `;首次抓取失败:${result.lastError}(会自动重试)` : ''}。`;
          }
          case 'refresh': {
            const outcome = await service.refresh({ channel: args.channel });
            return `刷新完成:成功 ${outcome.feeds} 个源,新增/更新 ${outcome.entries} 条${outcome.errors ? `,${outcome.errors} 个源失败` : ''}。`;
          }
          default:
            throw new Error(`未知 action：${String(args?.action)}`);
        }
      },
    }),

    // --------------------------------------------------------------- droplets_inbox
    defineTool({
      name: 'droplets_inbox',
      description: 'Droplets 收件箱:把网页/PDF/EPUB 链接存进来稍后处理、列出、阅读、处理完成移入回收站。与 Droplets 桌面端共用同一份数据(inbox/<id>/)。' + INBOX_ADD_TIMEOUT_NOTE,
      parameters: {
        action: {
          type: 'string',
          enum: ['add_url', 'list', 'read', 'mark_done'],
          description: 'add_url 抓取并存入;list 列出;read 读内容;mark_done 处理完成并移入回收站(可在 Droplets 回收站恢复)。',
          required: true,
        },
        url: { type: 'string', description: 'add_url 的目标链接 (http/https)。' },
        key: { type: 'string', description: 'read / mark_done 的条目 key(list 返回的 id)。' },
        filter: { type: 'string', description: 'list 的过滤:all | unread | finished | fetch_failed。' },
        tag: { type: 'string', description: 'list 的标签过滤(filter=all 时可组合)。' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        switch (args?.action) {
          case 'add_url': {
            if (typeof args?.url !== 'string' || !/^https?:\/\//i.test(args.url)) throw new Error('add_url 需要 http(s) url');
            const { item, duplicate } = await service.inboxAddUrl({ url: args.url });
            return { duplicate, item };
          }
          case 'list': {
            const status = args?.filter && args.filter !== 'all' ? args.filter : undefined;
            const { items, counts } = await service.inboxList({ status, tag: args?.tag });
            return { count: items.length, counts, items };
          }
          case 'read': {
            if (typeof args?.key !== 'string' || args.key === '') throw new Error('read 需要 key');
            const result = await service.inboxRead({ key: args.key });
            const body = result.text ?? '';
            return {
              item: result.item,
              text: body.length > 40_000 ? `${body.slice(0, 40_000)}\n…(已截断,共 ${body.length} 字符;PDF 可读 text 为空时表示需要按页提取)` : body,
            };
          }
          case 'mark_done': {
            if (typeof args?.key !== 'string' || args.key === '') throw new Error('mark_done 需要 key');
            const { removed, trashed } = await service.inboxMarkDone({ key: args.key });
            return { removed, trashed };
          }
          default:
            throw new Error(`未知 action：${String(args?.action)}`);
        }
      },
    }),

    // ---------------------------------------------------------------- droplets_vault
    defineTool({
      name: 'droplets_vault',
      description: 'Droplets 知识库:搜索/读取/写入/反链/列出 Markdown 笔记。整理收件箱材料成笔记、查询用户知识库时用它。write 必带 expected_sha 乐观锁。',
      parameters: {
        action: {
          type: 'string',
          enum: ['search', 'read', 'write', 'backlinks', 'list'],
          description: 'search 全库搜索;read 读笔记;write 写笔记(整文件);backlinks 查反链;list 列文件。',
          required: true,
        },
        query: { type: 'string', description: 'search 的搜索词(标题/标签/正文)。' },
        path: { type: 'string', description: '笔记的 vault 相对路径(search/read 返回;write 为目标路径,以 .md 结尾)。' },
        content: { type: 'string', description: 'write 的完整新内容(整文件替换,不是增量)。' },
        expected_sha: { type: 'string', description: 'write 的乐观锁:上次 read 返回的 sha;新文件传 null 或省略表示创建。' },
        limit: { type: 'number', description: 'search/list 的上限(默认 30)。' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        switch (args?.action) {
          case 'search': {
            if (typeof args?.query !== 'string' || args.query.trim() === '') throw new Error('search 需要 query');
            const { results } = await service.vaultSearch({ query: args.query, limit: Math.min(args.limit ?? 30, 100) });
            return { count: results.length, results };
          }
          case 'read': {
            if (typeof args?.path !== 'string' || args.path === '') throw new Error('read 需要 path');
            return service.vaultRead({ path: args.path });
          }
          case 'write': {
            if (typeof args?.path !== 'string' || args.path === '') throw new Error('write 需要 path(以 .md 结尾)');
            if (typeof args?.content !== 'string') throw new Error('write 需要 content(完整文件内容)');
            const expectedSha = args.expected_sha === null || args.expected_sha === undefined || args.expected_sha === 'null' ? undefined : String(args.expected_sha);
            const result = await service.vaultWrite({ path: args.path, content: args.content, expectedSha });
            if (result.conflict) {
              return {
                conflict: true,
                path: result.path,
                currentSha: result.currentSha,
                currentExcerpt: result.currentExcerpt,
                hint: '文件已被修改。请重新 read 拿到最新 sha 后再 write。',
              };
            }
            return { conflict: false, path: result.path, sha: result.sha, title: result.title, created: result.created === true };
          }
          case 'backlinks': {
            if (typeof args?.path !== 'string' || args.path === '') throw new Error('backlinks 需要 path');
            const { backlinks } = await service.vaultBacklinks({ path: args.path });
            return { count: backlinks.length, backlinks };
          }
          case 'list': {
            const status = await service.vaultStatus();
            if (status.files === 0) {
              return { files: 0, hint: '知识库还是空的。用 write 创建第一篇笔记,或在设置里把 vaultPath 指向现有 Markdown 库。' };
            }
            const { tree } = await service.vaultTree();
            const files = [];
            const walk = (node, prefix) => {
              const here = prefix ? `${prefix}/${node.name}` : node.name;
              for (const file of node.files) files.push({ path: file.path, title: file.title, wordCount: file.wordCount });
              for (const dir of node.dirs) walk(dir, here);
            };
            walk(tree, '');
            return { files: files.slice(0, Math.min(args.limit ?? 200, 500)), total: status.files, root: status.root };
          }
          default:
            throw new Error(`未知 action：${String(args?.action)}`);
        }
      },
    }),

  ];
}
