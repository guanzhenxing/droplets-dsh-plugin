// Extract the panel CSS (injected <style>) from the built bundle.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DROPLETS_NM = '/Users/jesen/WorkSpace/MyProjects/droplets/apps/desktop/node_modules';
const nmRequire = createRequire(path.join(DROPLETS_NM, 'x.js'));
const react = nmRequire('react');
const { JSDOM } = nmRequire('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
dom.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.MutationObserver = dom.window.MutationObserver;
const loaded = [];
window.__ModuleLoader__ = { load: (def) => loaded.push(def) };
const dshStub = new Proxy(function () {}, { apply: () => ({ apply: async () => ({}) }), get: () => (opts) => ({ apply: async () => ({}) }) });
const src = readFileSync('client.js', 'utf8');
const mod = { exports: {} };
const fakeRequire = (name) => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return nmRequire('react/jsx-runtime');
  if (name === 'react-dom' || name === 'react-dom/client') return nmRequire('react-dom/client');
  if (name.startsWith('@deepseek-ai/')) return dshStub;
  try { return nmRequire(name); } catch { return {}; }
};
new Function('require', 'module', 'exports', src)(fakeRequire, mod, mod.exports);
const client = loaded[0].factory(fakeRequire);
const childCtx = {
  remote: { droplets: new Proxy({}, { get: () => async () => ({ ok: true, value: {} }) }) },
  slots: { inject(n, reg) { reg(); }, register() { return () => {}; } },
  locale: { register() {} },
  inject(n, cb) { return cb(childCtx); },
};
const ctx = { effect(fn) { try { return fn(); } catch {} return () => {}; }, inject(names, cb) { return cb(childCtx); }, remote: { $mount: async () => {} }, logger: {} };
await client.apply(ctx);
writeFileSync(process.argv[2] ?? '/tmp/plugin-styles.css', document.querySelector('style').textContent);
console.log('css bytes:', document.querySelector('style').textContent.length, '| pane-btn rule:', document.querySelector('style').textContent.includes('.dpl-pane-btn {'));
