export function passkeyUnavailableReason() {
  if (!window.isSecureContext) return 'Passkeys need HTTPS or localhost. A LAN HTTP address cannot use passkeys; open your HTTPS Hub address.';
  if (typeof PublicKeyCredential === 'undefined') return 'This browser does not support passkeys. Use your access key instead.';
  return undefined;
}
export function passkeyError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  if (error instanceof Error && error.message === 'passkey_challenge_capacity') return 'Passkey requests are busy. Wait a few minutes and retry, or sign in with your access key.';
  if (error instanceof Error && error.message === 'passkey_verification_capacity') return 'Passkey verification is busy. Wait a moment and retry, or sign in with your access key.';
  if (error instanceof Error && error.message === 'passkey_verification_rate') return 'Too many passkey verification attempts. Wait one minute and retry, or sign in with your access key.';
  const bodyError = authBodyError(error);
  if (bodyError) return bodyError;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'Passkey prompt cancelled or timed out. Retry when ready, or use your access key.';
  if (name === 'InvalidStateError') return 'This authenticator already has a passkey for this account. Use it to sign in, or choose another device.';
  if (name === 'SecurityError') return 'Passkey site mismatch. Use the same HTTPS Hub hostname where you registered this passkey.';
  return error instanceof Error ? error.message : String(error);
}

export function authBodyError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  // Persistence can reject after COMMIT or a lost acknowledgement. Neither
  // access-key nor passkey UI may promise that no changes were saved.
  if (error.message === 'auth_persistence_failed') return 'Sign-in storage is unavailable. The result of the last operation could not be confirmed. Ask the Hub administrator to check storage and recovery status before retrying.';
  if (error.message === 'auth_body_capacity') return 'Sign-in requests are busy. Wait a moment and retry.';
  if (error.message === 'auth_body_timeout') return 'The sign-in request timed out. Check your connection and retry.';
  if (error.message === 'auth_body_too_large') return 'The sign-in request is too large. Check your access key or try another authenticator.';
  if (error.message === 'auth_body_invalid') return 'The sign-in request could not be read. Retry the sign-in flow.';
  return undefined;
}
