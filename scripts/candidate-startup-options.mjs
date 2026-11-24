import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

export function parseCandidateStartupArguments(args) {
  assert.ok(Array.isArray(args) && (args.length === 1 || args.length === 2)
    && typeof args[0] === 'string' && isAbsolute(args[0]),
  'Provide one absolute candidate directory and optionally --application-browser-recovery');
  assert.ok(args.length === 1 || args[1] === '--application-browser-recovery',
    'Unknown candidate startup option');
  return { candidateRoot: args[0], applicationBrowserRecovery: args.length === 2 };
}
