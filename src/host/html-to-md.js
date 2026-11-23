/**
 * HTML → Markdown for the inbox capture pipeline.
 *
 * Droplets stores inbox bodies as `content.md` (native pipeline:
 * sanitize → Readability → turndown). The plugin keeps its host bundle
 * dependency-light, so this converter covers the sanitizer's allowlist
 * output (see sanitize.js) instead of pulling turndown in. Everything the
 * sanitizer can emit has a mapping; unknown tags degrade to their text.
 */

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'br',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'figure', 'figcaption',
  'details', 'summary', 'address', 'main', 'form', 'fieldset',
]);

const HEADINGS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Decode the entity set the sanitizer leaves behind (plus stray ones). */
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&#(\d{1,7});/g, (_, code) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? safeCodePoint(point) : _.slice(1, -1);
    });
}

function safeCodePoint(point) {
  try { return String.fromCodePoint(point); } catch { return ''; }
}

/** Escape text so literal characters cannot re-open markdown markup.
 * Line-start specials (# > + - and ordered markers) only need escaping when
 * the text truly begins a markdown line — escaping them mid-sentence would
 * litter visible backslashes through ordinary prose like "2.1". */
function escapeText(text, atLineStart = false) {
  let out = text.replace(/([\\`*_\[\]~])/g, '\\$1');
  if (atLineStart) {
    out = out.replace(/^([ \t]*)([#>+-])/, '$1\\$2').replace(/^([ \t]*)(\d+)\./, '$1$2\\.');
  }
  return out;
}

function escapeCell(text) {
  return escapeText(text).replace(/\|/g, '\\|');
}

/** Tokenize the flat tag stream the sanitizer produces (no nesting repair). */
function tokenize(html) {
  const tokens = [];
  const pattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (match[3] !== undefined) {
      if (match[3] !== '') tokens.push({ kind: 'text', text: match[3] });
      continue;
    }
    if (match[0].startsWith('<!--')) continue;
    const name = match[1].toLowerCase();
    const closing = match[0][1] === '/';
    const attrs = {};
    const attrPattern = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr;
    while ((attr = attrPattern.exec(match[2] ?? '')) !== null) {
      attrs[attr[1].toLowerCase()] = decodeEntities(attr[3] ?? attr[4] ?? '');
    }
    tokens.push({ kind: 'tag', name, closing, attrs, selfClosing: /\/>$/.test(match[0]) });
  }
  return tokens;
}

/** Build a node tree from the token stream. */
function parse(tokens) {
  const root = { kind: 'element', name: '#root', children: [] };
  const stack = [root];
  for (const token of tokens) {
    const top = stack[stack.length - 1];
    if (token.kind === 'text') {
      top.children.push({ kind: 'text', text: token.text });
      continue;
    }
    if (token.closing) {
      // Pop to the NEAREST matching open tag from the top; ignore stray closers.
      for (let index = stack.length - 1; index >= 1; index -= 1) {
        if (stack[index].name === token.name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const node = {
      kind: 'element',
      name: token.name,
      attrs: token.attrs,
      children: [],
      selfClosing: token.selfClosing || token.name === 'br' || token.name === 'hr' || token.name === 'img',
    };
    top.children.push(node);
    if (!node.selfClosing) stack.push(node);
  }
  return root;
}

function nodeText(node) {
  if (node.kind === 'text') return decodeEntities(node.text);
  return (node.children ?? []).map(nodeText).join('');
}

/** Render inline content (returns markdown without block separation).
 * `state.lineStart` tracks whether the next chunk truly starts a markdown
 * line, so leading specials are escaped only where they would parse as
 * markup (paragraph starts); it flows through nested inline elements. */
function renderInline(nodes, state) {
  state = state ?? { lineStart: true };
  const parts = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      const flat = decodeEntities(node.text).replace(/\s*\n\s*/g, ' ');
      parts.push(escapeText(flat, state.lineStart));
      if (flat.trim() !== '') state.lineStart = false;
      continue;
    }
    const inner = () => renderInline(node.children, state);
    switch (node.name) {
      case 'br': parts.push('\n'); state.lineStart = true; break;
      case 'strong': case 'b': {
        const text = inner().trim();
        if (text !== '') parts.push(`**${text}**`);
        break;
      }
      case 'em': case 'i': {
        const text = inner().trim();
        if (text !== '') parts.push(`*${text}*`);
        break;
      }
      case 'del': case 's': {
        const text = inner().trim();
        if (text !== '') parts.push(`~~${text}~~`);
        break;
      }
      case 'code': case 'kbd': case 'samp': {
        const text = nodeText(node);
        if (text !== '') parts.push(text.includes('`') ? '`` ' + text + ' ``' : `\`${text}\``);
        break;
      }
      case 'a': {
        const href = String(node.attrs.href ?? '');
        const text = inner().trim() || href;
        if (href.startsWith('#')) parts.push(text);
        else if (href !== '') parts.push(`[${text}](${href})`);
        else parts.push(text);
        break;
      }
      case 'img': {
        const src = String(node.attrs.src ?? '');
        const alt = String(node.attrs.alt ?? '');
        if (src !== '') parts.push(`![${alt}](${src})`);
        break;
      }
      case 'sup': parts.push(`^${inner()}^`); break;
      case 'sub': parts.push(`~${inner()}~`); break;
      case 'mark': parts.push(`==${inner()}==`); break;
      default: parts.push(inner());
    }
  }
  return parts.join('');
}

/** Render block-level children into markdown lines. */
function renderBlocks(nodes, out, listDepth = 0) {
  const buffer = [];
  const flushParagraph = () => {
    const text = renderInline(buffer).replace(/[ \t]+\n/g, '\n').trim();
    buffer.length = 0;
    if (text !== '') out.push(text, '');
  };

  for (const node of nodes) {
    if (node.kind === 'text') {
      const decoded = decodeEntities(node.text);
      if (decoded.trim() !== '') buffer.push(node);
      else if (buffer.length > 0 && decoded.includes('\n')) buffer.push({ kind: 'text', text: ' ' });
      continue;
    }
    const inlineOnly = !BLOCK_TAGS.has(node.name);
    if (inlineOnly) {
      // Inline elements flow into the current paragraph.
      buffer.push(node);
      continue;
    }
    switch (node.name) {
      case 'br': {
        buffer.push({ kind: 'text', text: '\n' });
        break;
      }
      case 'hr': {
        flushParagraph();
        out.push('---', '');
        break;
      }
      case 'p': case 'div': case 'section': case 'article': case 'main':
      case 'header': case 'footer': case 'nav': case 'aside': case 'figure':
      case 'address': case 'fieldset': {
        flushParagraph();
        const nested = [];
        renderBlocks(node.children, nested, listDepth);
        if (nested.length > 0) out.push(...nested);
        break;
      }
      case 'figcaption': {
        flushParagraph();
        const text = renderInline(node.children, { lineStart: false }).trim();
        if (text !== '') out.push(`*${text}*`, '');
        break;
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        flushParagraph();
        const level = HEADINGS[node.name];
        const text = renderInline(node.children, { lineStart: false }).replace(/\n/g, ' ').trim();
        if (text !== '') out.push('#'.repeat(level) + ' ' + text, '');
        break;
      }
      case 'blockquote': {
        flushParagraph();
        const nested = [];
        renderBlocks(node.children, nested, listDepth);
        const body = nested.join('\n').replace(/\n{2,}/g, '\n\n').trimEnd();
        if (body !== '') {
          for (const line of body.split('\n')) out.push(line === '' ? '>' : '> ' + line);
          out.push('');
        }
        break;
      }
      case 'pre': {
        flushParagraph();
        const codeNode = node.children.find((child) => child.kind === 'element' && child.name === 'code');
        const language = /language-([\w-]+)/.exec(codeNode?.attrs?.class ?? node.attrs?.class ?? '')?.[1] ?? '';
        const text = codeNode ? nodeText(codeNode) : nodeText(node);
        const fence = '```';
        out.push(`${fence}${language}`, text.replace(/\n+$/, ''), fence, '');
        break;
      }
      case 'ul': case 'ol': {
        flushParagraph();
        renderList(node, out, listDepth);
        break;
      }
      case 'table': {
        flushParagraph();
        renderTable(node, out);
        break;
      }
      case 'details': {
        flushParagraph();
        renderBlocks(node.children, out, listDepth);
        break;
      }
      case 'summary': {
        flushParagraph();
        const text = renderInline(node.children, { lineStart: false }).trim();
        if (text !== '') out.push(`**${text}**`, '');
        break;
      }
      default: {
        flushParagraph();
        renderBlocks(node.children, out, listDepth);
      }
    }
  }
  flushParagraph();
}

function indentFor(depth) {
  return '  '.repeat(depth);
}

function renderList(node, out, depth) {
  const ordered = node.name === 'ol';
  let index = Number(node.attrs?.start ?? 1) || 1;
  for (const child of node.children) {
    if (child.kind !== 'element' || child.name !== 'li') continue;
    const nested = [];
    // Split direct inline content from nested lists/tables.
    const inlineParts = [];
    const blockParts = [];
    for (const part of child.children) {
      if (part.kind === 'element' && (part.name === 'ul' || part.name === 'ol' || part.name === 'table' || part.name === 'blockquote' || part.name === 'pre')) {
        blockParts.push(part);
      } else if (part.kind === 'element' && part.name === 'p') {
        const inner = renderInline(part.children, { lineStart: false }).trim();
        if (inner !== '') inlineParts.push(inner);
      } else {
        inlineParts.push(part);
      }
    }
    const marker = ordered ? `${index}. ` : '- ';
    const head = renderInline(inlineParts, { lineStart: false }).replace(/\n+/g, ' ').trim();
    out.push(indentFor(depth) + marker + (head !== '' ? head : ''));
    for (const part of blockParts) {
      if (part.name === 'ul' || part.name === 'ol') renderList(part, out, depth + 1);
      else if (part.name === 'table') renderTable(part, out, depth + 1);
      else if (part.name === 'blockquote') {
        const nested = [];
        renderBlocks([part], nested, depth + 1);
        for (const line of nested.join('\n').trimEnd().split('\n')) {
          out.push(indentFor(depth + 1) + (line === '' ? '>' : line.replace(/^> ?/, '> ')));
        }
      } else if (part.name === 'pre') {
        const text = nodeText(part);
        out.push(indentFor(depth + 1) + '```', ...text.replace(/\n+$/, '').split('\n').map((line) => indentFor(depth + 1) + line), indentFor(depth + 1) + '```');
      }
    }
    if (ordered) index += 1;
  }
  if (depth === 0) out.push('');
}

function renderTable(node, out, depth = 0) {
  const rows = [];
  const collect = (tr) => {
    const cells = [];
    for (const cell of tr.children) {
      if (cell.kind !== 'element' || (cell.name !== 'td' && cell.name !== 'th')) continue;
      cells.push(escapeCell(renderInline(cell.children, { lineStart: false }).replace(/\n+/g, ' ').trim()));
    }
    if (cells.length > 0) rows.push({ header: false, cells });
  };
  const walk = (children) => {
    for (const child of children) {
      if (child.kind !== 'element') continue;
      if (child.name === 'tr') {
        if (child.children.some((cell) => cell.kind === 'element' && cell.name === 'th')) {
          const cells = [];
          for (const cell of child.children) {
            if (cell.kind !== 'element' || (cell.name !== 'td' && cell.name !== 'th')) continue;
            cells.push(escapeCell(renderInline(cell.children, { lineStart: false }).replace(/\n+/g, ' ').trim()));
          }
          if (cells.length > 0) rows.unshift({ header: true, cells });
        } else collect(child);
      } else walk(child.children);
    }
  };
  walk(node.children);
  if (rows.length === 0) return;
  const width = Math.max(...rows.map((row) => row.cells.length));
  const pad = (row) => {
    const cells = [...row.cells];
    while (cells.length < width) cells.push('');
    return cells;
  };
  const first = rows[0];
  const prefix = indentFor(depth);
  out.push(prefix + '| ' + pad(first).join(' | ') + ' |');
  out.push(prefix + '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |');
  for (const row of rows.slice(first.header ? 1 : 0)) {
    out.push(prefix + '| ' + pad(row).join(' | ') + ' |');
  }
  out.push('');
}

/**
 * Convert sanitized HTML to markdown.
 * @param {string} html allowlist-sanitized HTML (sanitize.js output)
 * @returns {string} markdown document
 */
export function htmlToMarkdown(html, { maxLength = 400_000 } = {}) {
  const tree = parse(tokenize(String(html ?? '')));
  const out = [];
  renderBlocks(tree.children, out);
  let markdown = out.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  // Literal text was escaped defensively; unescape the harmless leftovers in
  // code-free contexts is not worth the complexity — markdown renderers show
  // the escapes correctly. Cap the document length.
  if (markdown.length > maxLength) markdown = markdown.slice(0, maxLength).trimEnd() + '\n\n…(内容过长已截断)';
  return markdown;
}
