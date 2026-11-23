# Droplets · DSH 插件

信息流 + 收件箱 + 知识库三空间,以 DeepSeek Harness 插件形态实现:一个侧栏入口,main 面板内三空间切换,配原生 AI 伴读与 Agent 工具。

- **信息流**:RSS 2.x / RSS 1.0 (RDF) / Atom 1.0 / JSON Feed 订阅,OPML 导入导出,源分组,未读在前 + 会话内冻结排序,收藏,搜索,远程图片 lazy + no-referrer,可关闭图片。
- **收件箱**:droplets 桌面端收件箱的 1:1 移植(筛选/条目/阅读三栏 + 右缘辅助轨道);数据直接落在 Droplets 工作区 `inbox/<uuid>/{content.md, meta.json}`(与桌面端完全同一份);添加 URL 建未读占位后后台抓取(首字节 20s / 总 60s / 50MB 上限),正文转 Markdown 存档;PDF/EPUB 原件存 `source/original.*` 并就地阅读(pdfjs / fflate);抓取失败占位可重试(单条/全部);标签编辑;处理完成 = 保留到资料库(inbox→library 迁移事务,与原生同构)或移入回收站(`.trash/` 暂存提交,可在 Droplets 回收站恢复)。
- **知识库**:指向任意 Markdown 目录(默认位置自带 PARA 骨架);标题/标签倒排 + 正文子串搜索;mtime+size 索引失效;wikilink 可点、未解析可创建;反链;图谱(d3-force 确定性布局);源码级轻编辑,`expected_sha` 乐观锁 + 冲突三选(重载/覆盖/另存)。
- **AI 集成**:宿主原生伴读(会话创建/retain/SessionProvider 嵌入,材料上下文经 systemPrompt 注入,选段为默认对象);三个多 action 工具 `droplets_feed` / `droplets_inbox` / `droplets_vault` 与面板共用同一实现。

## 安装

```bash
npm pack            # 产出 droplets-dsh-x.y.z.tgz(内含构建产物)
```

把 tgz 加入 DSH profile 的依赖与 cordis.patch(bundle patch 由 `dsh.profile.bundles` 应用),或按宿主插件市场的本地安装路径安装:

```yaml
# profile 的 cordis.patch.yml
- insert:
    - id: droplets
      name: 'droplets-dsh'
```

要求 DSH ≥ 0.2.1-rc.2(peerDeps 钉了实测版本列表;新 RC 先跑冒烟再放宽)。

## 配置(Config)

| 键 | 默认 | 说明 |
|---|---|---|
| `vaultPath` | `$DSH_HOME/storages/droplets-dsh/vault` | 知识库目录,可指向现有 Markdown 库;改动即重建倒排缓存 |
| `refreshInterval` | 60000 | 信息流自动刷新间隔(毫秒,下限 60s) |
| `maxBodies` | 300 | 正文缓存上限(收藏置顶保护) |
| `enableTranslation` | false | 条目翻译(M4,预留) |

## 数据与所有权

- 全文件化:`$DSH_HOME/storages/droplets-dsh/` 下 `data.json`(订阅/未读/收藏/倒排缓存)、`bodies.json`(正文缓存,懒加载 + 上限淘汰)、`vault/`(默认知识库);收件箱为 Droplets 原生格式,独立于存储后端(共用工作区时在 `<workspace>/inbox/`,私有模式在 `storages/droplets-dsh/inbox-workspace/`)。
- 原子写(tmp+rename)+ 500ms 防抖;卸载不删 storages;设置里有"清空插件数据"。
- 导出 = 拷目录 + OPML。

## 安全

- SSRF:guardedFetch——DNS 解析 → 公网校验(拒绝回环/RFC1918/CGNAT/链路本地/组播/v4 映射 v6 等)→ 拨号钉死校验过的 IP(防 DNS rebinding,SNI/证书校验保留)→ 重定向逐跳重检 → 端口仅 80/443;跨域 307/308 携正文直接拒绝。
- 内容净化双层:入库 allowlist sanitizer(脚本/事件/危险协议一律不出现在输出)+ 渲染层 DOMPurify;渲染不经 innerHTML 赋值(DOMParser + 节点搬运)。
- `vault_write` 路径逐段 lstat + realpath,拒绝符号链接与越界;`expected_sha` 乐观锁冲突返回当前 sha 与摘要。
- EPUB 解压三重限额(单条目 64MB / 总量 256MB / 文件数 2000);PDF/EPUB 单文件 ≤256MB。
- 零凭据持有。

## Agent 工具

- `droplets_feed`:`list_channels | list_articles | read | search | add_subscription | refresh`
- `droplets_inbox`:`add_url | list | read | mark_done`(与面板共用工作区收件箱;`mark_done` = 移入 Droplets 回收站,可恢复)
- `droplets_vault`:`search | read | write | backlinks | list`(`write` 必带 `expected_sha`,新文件传 null)

## 开发

```bash
npm install
npm run build     # esbuild 双产物:index.js(host)+ client.js(client)
npm test          # 61 项:解析 fixture/净化/SSRF/prune 竞态/路径安全/限额/伴读守命/工具契约
npm run check     # build + test + 产物 git diff --exit-code
```

测试通过 `tests/register-peers.mjs` 的 module-resolution 钩子把 `@deepseek-ai/*` peer 重定向到本地桩,因此无需真实宿主即可做契约级验证;宿主内行为以 M0 冒烟(装 tgz 验伴读链 + 工具)为准。

## 目录

```
├── index.js / client.js     # 构建产物(入库)
├── src/host/                # 服务、store、feeds、guarded-fetch、inbox、vault、tools、context
├── src/client/              # 面板、三空间视图、伴读、markdown、pdf/epub、图谱布局
├── locale/{zh,en}.json      # 双语文案(M0 起)
└── tests/                   # node --test 套件 + peer 桩
```

## 宿主冒烟记录(M0/M1/M2/M3 实测)

在隔离 profile(DSH_HOME 指向插件目录下 .m0-home,dsh --profile droplets-m0 --from-default-profile web)安装 tgz 后真机验证:

- 插件装载:侧栏 Droplets 入口、main 面板三空间 tab、vault PARA 骨架自动创建;
- 信息流:订阅 Cloudflare Blog → 刷新 → 20 条真实条目 → 打开阅读(正文/作者/原文链接)→ 未读计数联动;
- 收件箱:存入 https://example.com → 抓取 → "Example Domain" 正文渲染;
- 知识库:新建笔记 → 树中出现 → 编辑(frontmatter/正文/wikilink)→ 保存 → 回读渲染;
- 伴读:面板嵌入宿主原生会话(composer/模型选择完整),材料切换时上下文标题同步(文章 ↔ 笔记)。

实测中发现并修复的两个宿主级问题(均有回归测试):
1. 产物参数名重命名:bundle 内 undici 的顶层 request 导出会让 esbuild 把服务方法参数 request 改名为 request2,typert 网关按参数名内省,所有带参 Remote 调用报 unexpected "request"。修复:导入改别名(request as undiciRequest),并以产物签名断言固化。
2. fake-IP 代理环境:本机 Clash 类代理的 DNS 返回 198.18.0.0/15 虚假地址,严格公网校验会拒绝一切外访。按 droplets 原版语义补齐:fake-IP 段放行并交由系统 http(s) 代理(自实现 CONNECT 隧道连接器,http/https 目标统一,SNI/证书校验保留);无代理可用时返回明确错误码 FETCH_FAKEIP_NO_PROXY。

## 决策记录(对照实现方案)

- 待拍板 A 搜索:倒排+子串(已实现)。
- 待拍板 B vault 位置:可配置(已实现,默认位置带 PARA 骨架)。
- 待拍板 C 翻译:M4 再议(Config 键预留)。
- 待拍板 D 收件箱去向:① 转知识库 + ② 即走(已实现)。
- 待拍板 E 编辑器深度:② 轻编辑,源码级整文件原子写 + baseSha 冲突三选(已实现)。
- M2 正文抽取:② 轻量自写(htmlToText 级),不引 JSDOM。
- Config 采用手写 Standard Schema v1(与宿主校验契约一致,零依赖;参照乔木阅读的同款做法)。
