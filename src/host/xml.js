/**
 * Tolerant XML front-end built on fast-xml-parser, exposing the same mini-DOM
 * helpers the reference readers use (find/findAll/childrenOf/textOf/attrOf).
 *
 * Security posture: DTD declarations are rejected outright and entity
 * processing is disabled at the parser level, so custom or external entities
 * are never expanded; the five predefined entities plus numeric character
 * references are decoded by explicit post-processing instead.
 */
import { XMLParser } from 'fast-xml-parser';

/** Maximum nesting depth accepted before the parser gives up. */
const MAX_DEPTH = 128;

export class XmlParseError extends Error {
  constructor(message) {
    super(`droplets: ${message}`);
    this.name = 'XmlParseError';
  }
}

const PARSER = new XMLParser({
  preserveOrder: true,
  processEntities: false,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  stopNodes: ['*.__cdata'],
});

/** Decode the predefined entities plus numeric character references. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos);/g, (raw, body) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body.charCodeAt(1) === 120 || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return raw;
    try {
      return String.fromCodePoint(code);
    } catch {
      return raw;
    }
  });
}

function nodeName(entry) {
  const key = Object.keys(entry).find((name) => name !== '#text' && name !== ':@');
  return key ?? '#text';
}

/** Strip namespace prefix, keeping local names for matching by suffix. */
export function localName(name) {
  const at = name.indexOf(':');
  return at === -1 ? name : name.slice(at + 1);
}

/**
 * fast-xml-parser preserveOrder shape: each element is
 * { tagName: [children], ":@": { "@_attr": value } } and text nodes are
 * { "#text": "..." }. Attributes live on the element itself under the
 * reserved ":@" key; children build recursively.
 */
function build(entry) {
  const name = nodeName(entry);
  if (name === '#text') {
    const text = typeof entry['#text'] === 'string' ? entry['#text'] : '';
    return { type: 'text', text };
  }
  const node = {
    type: 'element',
    name,
    local: localName(name),
    attrs: {},
    children: [],
    text: '',
  };
  const attrs = entry[':@'];
  if (attrs && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('@_')) node.attrs[key.slice(2)] = typeof value === 'string' ? value : String(value);
    }
  }
  const value = entry[name];
  if (Array.isArray(value)) {
    for (const child of value) {
      const childName = nodeName(child);
      if (childName === '#text') {
        node.children.push({ type: 'text', text: typeof child['#text'] === 'string' ? child['#text'] : '' });
      } else if (childName !== undefined) {
        node.children.push(build(child));
      }
    }
  } else if (typeof value === 'string') {
    node.children.push({ type: 'text', text: value });
  }
  node.text = node.children.filter((child) => child.type === 'text').map((child) => child.text).join('');
  return node;
}

function depthCheck(node, depth) {
  if (depth > MAX_DEPTH) throw new XmlParseError('document nesting exceeds the accepted depth');
  for (const child of node.children) {
    if (child.type === 'element') depthCheck(child, depth + 1);
  }
}

/**
 * Parse an XML document into a mini-DOM root wrapper.
 * @param {string} xmlText - raw XML text (already size-capped by the caller).
 * @returns {{type:'element',name:string,attrs:object,children:object[],text:string}}
 */
/** Remove a DOCTYPE declaration (with its optional internal subset). Many
 * legitimate feeds ship one; the declaration itself carries no data we use. */
function stripDoctype(text) {
  // Linear scan — a nested-quantifier regex here backtracks catastrophically
  // on large feeds. Handles the optional [ ... ] internal subset.
  const start = text.search(/<!DOCTYPE/i);
  if (start === -1) return text;
  let index = start + '<!DOCTYPE'.length;
  let depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
    else if (char === '>' && depth <= 0) break;
    index += 1;
  }
  return text.slice(0, start) + text.slice(index + 1);
}

export function parseXml(xmlText) {
  // XXE guard: entity declarations are refused outright (they are the actual
  // attack surface), but a bare DOCTYPE is stripped rather than rejected —
  // refusing it dropped whole legitimate feeds.
  if (/<!ENTITY/i.test(xmlText)) {
    throw new XmlParseError('documents with entity declarations are rejected');
  }
  const sanitized = stripDoctype(xmlText);
  let raw;
  try {
    raw = PARSER.parse(sanitized);
  } catch (error) {
    throw new XmlParseError(`malformed XML (${error?.message ?? error})`);
  }
  if (!Array.isArray(raw)) throw new XmlParseError('empty document');
  const root = { type: 'element', name: '#document', attrs: {}, children: [], text: '' };
  for (const entry of raw) {
    const node = build(entry);
    if (node.type === 'element' || (node.type === 'text' && node.text.trim() !== '')) {
      root.children.push(node);
    }
  }
  depthCheck(root, 0);
  return root;
}

export function childrenOf(node, tag) {
  const wanted = tag.toLowerCase();
  return (node?.children ?? []).filter(
    (child) => child.type === 'element' && (child.local.toLowerCase() === wanted || child.name.toLowerCase() === wanted),
  );
}

export function findAll(node, tag) {
  const out = [];
  const wanted = tag.toLowerCase();
  const visit = (current) => {
    for (const child of current?.children ?? []) {
      if (child.type !== 'element') continue;
      if (child.local.toLowerCase() === wanted || child.name.toLowerCase() === wanted) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

export function find(node, tag) {
  const wanted = tag.toLowerCase();
  for (const child of node?.children ?? []) {
    if (child.type === 'element' && (child.local.toLowerCase() === wanted || child.name.toLowerCase() === wanted)) return child;
  }
  return undefined;
}

export function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return decodeEntities(node.text ?? '');
  return decodeEntities(node.text ?? '');
}

export function attrOf(node, name) {
  if (!node || node.type !== 'element') return undefined;
  const value = node.attrs[name];
  return typeof value === 'string' ? decodeEntities(value) : undefined;
}
