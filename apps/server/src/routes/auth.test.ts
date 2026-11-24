import assert from 'node:assert/strict';
import test from 'node:test';
import { __test_registrationCredentialFromBody } from './auth.js';

test('registrationCredentialFromBody keeps direct WebAuthn credential id', () => {
  const credential = {
    id: 'credential-id',
    rawId: 'credential-id',
    type: 'public-key',
    response: { clientDataJSON: 'client', attestationObject: 'attestation' },
  };
  assert.equal(__test_registrationCredentialFromBody(credential), credential);
});

test('registrationCredentialFromBody unwraps labeled credential envelope', () => {
  const credential = { id: 'credential-id', response: { clientDataJSON: 'client' } };
  assert.equal(__test_registrationCredentialFromBody({ credential, label: 'Laptop' }), credential);
});
