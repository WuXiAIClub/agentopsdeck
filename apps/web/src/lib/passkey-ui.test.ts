import assert from 'node:assert/strict';
import test from 'node:test';
import { authBodyError, passkeyError } from './passkey-ui.js';

test('unconfirmed persistence gives the same safe recovery guidance for access keys and passkeys', () => {
  const error = new Error('auth_persistence_failed'), message = authBodyError(error);
  assert.equal(passkeyError(error), message);
  assert.match(message!, /could not be confirmed/);
  assert.match(message!, /administrator.*storage.*recovery.*before retrying/);
  assert.doesNotMatch(message!, /not saved|nothing was saved|retry now|automatically/);
});

test('bounded request failures are actionable for key login and passkey login/registration', () => {
  for (const [code, expected] of [['capacity', /busy.*retry/], ['timeout', /timed out.*connection/],
    ['too_large', /too large.*authenticator/], ['invalid', /could not be read.*Retry/]] as const) {
    const error = new Error('auth_body_' + code);
    assert.match(authBodyError(error)!, expected);
    assert.equal(passkeyError(error), authBodyError(error));
  }
  assert.equal(authBodyError(new Error('unrelated')), undefined);
  assert.equal(authBodyError('auth_body_capacity'), undefined);
});

test('passkey capacity gives an actionable message in login and registration instead of a raw code', () => {
  assert.equal(passkeyError(new Error('passkey_challenge_capacity')), 'Passkey requests are busy. Wait a few minutes and retry, or sign in with your access key.');
  assert.equal(passkeyError(new Error('passkey_verification_capacity')), 'Passkey verification is busy. Wait a moment and retry, or sign in with your access key.');
  assert.equal(passkeyError(new Error('passkey_verification_rate')), 'Too many passkey verification attempts. Wait one minute and retry, or sign in with your access key.');
  assert.match(passkeyError(new Error('auth_persistence_failed')), /could not be confirmed.*administrator.*recovery/);
});

test('existing device cancellation, site mismatch and unknown errors remain distinct', () => {
  assert.match(passkeyError(new DOMException('cancelled', 'NotAllowedError')), /cancelled or timed out/);
  assert.match(passkeyError(new DOMException('aborted', 'AbortError')), /cancelled or timed out/);
  assert.match(passkeyError(new DOMException('duplicate', 'InvalidStateError')), /already has a passkey/);
  assert.match(passkeyError(new DOMException('mismatch', 'SecurityError')), /site mismatch/);
  assert.equal(passkeyError(new Error('network unavailable')), 'network unavailable');
  assert.equal(passkeyError('unknown'), 'unknown');
});
