#!/usr/bin/env node
// Explicit optional setup; never runs during package installation.
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, chmodSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const repair = args[0] === '--repair';
const directoryArgument = repair ? args[1] : args[0];
const explicitSeed = !repair && args[1] === '--last-used-sequence' && args.length === 3;
if (!directoryArgument || (repair ? args.length !== 2 : args.length !== 1 && !explicitSeed)) {
  console.error('Usage: bambu-printer-mcp-signing-setup <absolute-private-state-directory> [--last-used-sequence <20000..2147483646>]\n       bambu-printer-mcp-signing-setup --repair <existing-private-state-directory>');
  process.exit(1);
}
// Random first-use starting point reduces accidental collisions with independent
// controllers. It is not a global namespace or proof that a reply was caused by
// this request. Explicit seed supports recovery from known local history.
const initial = explicitSeed ? Number(args[2]) : randomInt(20000, 2 ** 30);
if (!Number.isSafeInteger(initial) || initial < 20000 || initial >= 2147483647 || resolve(directoryArgument) !== directoryArgument) throw new Error('SIGNING_SETUP_ARGUMENTS_INVALID');
mkdirSync(directoryArgument, { recursive: true, mode: 0o700 });
const directory = realpathSync(directoryArgument);
const st = statSync(directory);
if (directory !== directoryArgument || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('Signing state directory must be owned and private (0700), without symlinks');
const temporary = join(directory, `counter-helper.build.${process.pid}`);
function durable(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
try {
  execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', fileURLToPath(new URL('./signing-counter.c', import.meta.url)), '-o', temporary], { timeout: 30000, stdio: 'pipe' });
  chmodSync(temporary, 0o700); durable(temporary);
  execFileSync(temporary, repair ? ['check', directory] : ['init', directory, String(initial)], { timeout: 5000, stdio: 'pipe' });
  renameSync(temporary, join(directory, 'counter-helper')); durable(directory);
  console.error(`Signing counter ${repair ? 'helper repaired without resetting state' : 'initialized'}. Reservations coordinate only processes sharing this directory; other controllers have independent sequences.`);
} catch {
  throw new Error('SIGNING_SETUP_FAILED: requires a POSIX C compiler and private counter state; existing counters are never reset (use --repair to rebuild only the helper)');
} finally { rmSync(temporary, { force: true }); }
