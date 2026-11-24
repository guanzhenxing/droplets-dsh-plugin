/**
 * Markdown → HTML for vault notes and companion text, rendered through
 * DOMPurify on the display side (the render layer never assigns innerHTML
 * with unsanitized markup). Wikilinks become actionable anchors the panel
 * resolves (existing note → open; unresolved → create).
 */

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  let out = escapeHtml(text);
  const codes = [];
  out = out.replace(/\`([^\`]+)\`/g, (_, code) => {
    codes.push('<code>' + code + '</code>');
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '" loading="lazy" referrerpolicy="no-referrer">')
    // Obsidian-style image embeds ![[name.png]] — rendered as images whose
    // src stays the raw reference; vault views resolve them asynchronously.
    .replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g, (_, name) => '<img src="' + escapeAttr(String(name).trim()) + '" alt="' + escapeAttr(String(name).trim()) + '" loading="lazy" referrerpolicy="no-referrer">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
      const safe = /^(?:https?:|mailto:|\/|#|dpl-note:)/i.test(href) ? href : '#';
      return '<a href="' + escapeAttr(safe) + '" target="_blank" rel="noreferrer">' + label + '</a>';
    })
    // wikilinks [[target|display]] / [[target]]
    .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_, target, display) => {
      const clean = String(target).trim();
      if (clean === '') return _;
      return '<a class="dpl-wikilink" href="dpl-note:' + encodeURIComponent(clean) + '" data-dpl-target="' + escapeAttr(clean) + '">' + escapeHtml(String(display ?? clean).trim() || clean) + '</a>';
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(?:^|\s)(#[^\s#]+)/g, (raw, tag) => ' <span class="dpl-tag">' + escapeHtml(tag) + '</span>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)] ?? '');
}

/** Render a Markdown document to HTML (pre-sanitization). */
export function markdownToHtml(markdown) {
  let text = String(markdown ?? '').replace(/\r\n/g, '\n');
  // Strip a leading YAML frontmatter block: it is metadata, not content.
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (frontmatter) text = text.slice(frontmatter[0].length);
  const lines = text.split('\n');
  const out = [];
  let paragraph = [];
  let listType;
  let inQuote = false;
  let codeFence = false;
  let codeBuffer = [];
  let codeLang = '';

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push('<p>' + inline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType !== undefined) {
      out.push('</' + listType + '>');
      listType = undefined;
    }
  };
  const closeQuote = () => {
    if (inQuote) { out.push('</blockquote>'); inQuote = false; }
  };

  for (const line of lines) {
    if (codeFence) {
      if (/^\`\`\`/.test(line)) {
        out.push('<pre data-lang="' + escapeAttr(codeLang) + '"><code>' + escapeHtml(codeBuffer.join('\n')) + '</code></pre>');
        codeFence = false;
        codeBuffer = [];
        codeLang = '';
      } else codeBuffer.push(line);
      continue;
    }
    if (/^\`\`\`/.test(line)) {
      closeParagraph(); closeList(); closeQuote();
      codeFence = true;
      codeLang = /^\`\`\`\s*(\w+)/.exec(line)?.[1] ?? '';
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeParagraph(); closeList(); closeQuote();
      const level = heading[1].length;
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeParagraph(); closeList(); closeQuote();
      out.push('<hr>');
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      closeParagraph(); closeQuote();
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) { closeList(); out.push('<' + wanted + '>'); listType = wanted; }
      out.push('<li>' + inline((bullet ?? ordered)[1]) + '</li>');
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeParagraph(); closeList();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push('<p>' + inline(quote[1]) + '</p>');
      continue;
    }
    closeQuote();
    if (line.trim() === '') { closeParagraph(); closeList(); continue; }
    paragraph.push(line.trim());
  }
  if (codeFence && codeBuffer.length > 0) {
    out.push('<pre><code>' + escapeHtml(codeBuffer.join('\n')) + '</code></pre>');
  }
  closeParagraph(); closeList(); closeQuote();
  return out.join('\n');
}

/** Sanitize rendered HTML with DOMPurify (render layer; browser window). */
import createDOMPurify from 'dompurify';
let purifier;
function getPurifier() {
  if (purifier !== undefined) return purifier;
  purifier = typeof window === 'undefined' ? null : createDOMPurify(window);
  return purifier;
}

export function purifyHtml(html) {
  const purify = getPurifier();
  if (purify === null) return html;
  return purify.sanitize(html, {
    ADD_ATTR: ['target', 'loading', 'referrerpolicy', 'data-dpl-target'],
    ADD_TAGS: [],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|dpl-note):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
}
