import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A disposable DSH_HOME so every test writes into its own storages tree. */
export function tempHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'droplets-test-'));
  process.env.DSH_HOME = dir;
  return {
    dir,
    async [Symbol.asyncDispose || Symbol.for('Symbol.asyncDispose')]() { cleanup(dir); },
    cleanup: () => cleanup(dir),
  };
}

function cleanup(dir) {
  // A debounced flush may still be landing per-feed entry files when a test
  // finishes; retry instead of failing the test on a transient ENOTEMPTY.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  delete process.env.DSH_HOME;
}

/** Minimal Cordis-shaped context for the service constructor. */
export function fakeCtx(logger) {
  const effects = [];
  const injections = [];
  return {
    logger: logger ?? {
      info() {}, warn() {}, error() {},
      child: () => ({ info() {}, warn() {}, error() {} }),
    },
    effect(fn, _name) { const dispose = fn(); effects.push(dispose); return dispose; },
    inject(names, callback) {
      injections.push({ names, callback });
      return () => {};
    },
    get(name) { return undefined; },
    // Waits for async disposers (the service's final flush): a test that
    // cleans up its home right after dispose() must not pull the directory out
    // from under a flush that is still running.
    async dispose() { for (const dispose of effects.reverse()) { try { await dispose?.(); } catch { /* best effort */ } } },
    __injections: injections,
  };
}
