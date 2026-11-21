# Third-party notices

droplets-dsh bundles the following dependencies into its artifacts:

- **fast-xml-parser** (Apache-2.0) — RSS/Atom/OPML parsing front-end.
- **undici** (MIT) — pinned-IP HTTP dispatching for the SSRF-guarded fetch.
- **ip-address** (MIT) — IPv4/IPv6 CIDR classification for public-address checks.
- **fflate** (MIT) — EPUB zip reading (host text extraction and client reader).
- **pdfjs-dist** (Apache-2.0) — PDF rendering (client) and text extraction (host tools).
- **d3-force** (ISC) — wiki graph simulation (client), deterministic port of the droplets layout.
- **DOMPurify** (Apache-2.0 / MPL-2.0 dual) — render-layer HTML sanitization in the browser.

Design references studied during development (GPL-3.0, not linked): qiaomu-rss-dsh
and qiaomu-reader-dsh plugin structures, droplets' guardedFetchCore/security and
wikiGraphLayout. This plugin is licensed GPL-3.0-only.
