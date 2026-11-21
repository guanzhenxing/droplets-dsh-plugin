import { homedir } from 'node:os';
import path from 'node:path';
/** Test stub: env-driven home so tests get an isolated storages tree. */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh');
}
