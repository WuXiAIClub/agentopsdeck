import { api, forgetStoredAccessKey } from '../api';
import { clearAllCachedData } from './session-cache';

// Explicit user sign-out only. Read-only startup recovery must not call this.
export function lockDeck() {
  forgetStoredAccessKey();
  clearAllCachedData();
  void api.logout().catch(() => undefined).finally(() => {
    window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required'));
  });
}
