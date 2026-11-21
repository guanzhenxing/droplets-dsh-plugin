/**
 * Module-resolution hooks for tests: redirect the harness peer packages to
 * local stubs so the service and tools import without a real host. Loaded
 * via `node --import ./tests/register-peers.mjs --test tests/`.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./resolve-hooks.mjs', import.meta.url).href);
