type CompatibleCrypto = Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>;

export function installRandomUUID(crypto: CompatibleCrypto): void {
  if (typeof crypto.randomUUID === 'function') return;
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: (): ReturnType<Crypto['randomUUID']> => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<Crypto['randomUUID']>;
    },
  });
}

if (globalThis.crypto) installRandomUUID(globalThis.crypto);
