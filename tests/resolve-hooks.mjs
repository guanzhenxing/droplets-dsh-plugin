import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stubs = path.join(here, 'peer-stubs');
const redirect = new Map([
  ['@deepseek-ai/dsh-typert-protocol', path.join(stubs, '@deepseek-ai/dsh-typert-protocol/index.js')],
  ['@deepseek-ai/dsh-tools', path.join(stubs, '@deepseek-ai/dsh-tools/index.js')],
  ['@deepseek-ai/dsh-home-paths', path.join(stubs, '@deepseek-ai/dsh-home-paths/index.js')],
]);

export async function resolve(specifier, context, next) {
  const target = redirect.get(specifier);
  if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  return next(specifier, context);
}
