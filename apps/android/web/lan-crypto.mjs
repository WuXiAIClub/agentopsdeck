export function installLanCrypto(crypto, send) {
  const pending = new Map();
  let sequence = 0;
  if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } });
  if (!crypto.subtle) Object.defineProperty(crypto, 'subtle', { value: {
    async digest(algorithm, data) {
      if (String(typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase() !== 'SHA-256') {
        throw new DOMException('Only SHA-256 is available on LAN', 'NotSupportedError');
      }
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      if (bytes.length > 24 * 1024 * 1024 || pending.size >= 8) throw new RangeError('Digest limit exceeded');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Digest timed out')); }, 30000);
        pending.set(id, { resolve, reject, timeout });
        try { send({ type: 'crypto.sha256', id, base64: btoa(binary) }); }
        catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
      });
    },
  } });
  return packet => {
    if (packet.type !== 'crypto.result') return;
    const request = pending.get(packet.id);
    if (!request) return;
    pending.delete(packet.id);
    clearTimeout(request.timeout);
    try { request.resolve(Uint8Array.from(atob(packet.base64), character => character.charCodeAt(0)).buffer); }
    catch (error) { request.reject(error); }
  };
}
