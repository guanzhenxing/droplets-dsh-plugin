/**
 * Client locale: flat dictionaries imported from locale/{zh,en}.json at build
 * time. The active language follows the host document language; lookups fall
 * back zh → en → key. `t('a.b')` resolves dotted paths; `{x}` placeholders
 * interpolate from the second argument.
 */
import zh from '../../locale/zh.json';
import en from '../../locale/en.json';

const DICTS = { zh: flatten(zh), en: flatten(en) };

function flatten(value, prefix = '', out = {}) {
  for (const [key, item] of Object.entries(value ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (item && typeof item === 'object') flatten(item, path, out);
    else out[path] = String(item);
  }
  return out;
}

export function currentLanguage() {
  const lang = (typeof document !== 'undefined' && document.documentElement?.lang) || 'zh';
  return lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

export function t(key, params) {
  const dict = DICTS[currentLanguage()] ?? DICTS.zh;
  const template = dict[key] ?? DICTS.zh[key] ?? DICTS.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (raw, name) => (params[name] === undefined ? raw : String(params[name])));
}
