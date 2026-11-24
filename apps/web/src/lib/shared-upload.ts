import { copySharedMessageInput, SHARED_ATTACHMENT_MAX_BYTES, SHARED_ATTACHMENTS_MAX_BYTES, type SendMessageUpload } from '@agentopsdeck/shared';

export const SHARED_IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
export async function readSharedImages(files: File[], signal: AbortSignal): Promise<SendMessageUpload[]> {
  if (!files.length || files.length > 8 || files.some(file => !SHARED_IMAGE_ACCEPT.split(',').includes(file.type)
    || file.size < 1 || file.size > SHARED_ATTACHMENT_MAX_BYTES)
    || files.reduce((sum, file) => sum + file.size, 0) > SHARED_ATTACHMENTS_MAX_BYTES) throw Error('Invalid shared image selection');
  const media: SendMessageUpload[] = [];
  // Serial physical reads bound peak decoded memory, and abort ownership is
  // retained until each FileReader settles. No persistence or network upload.
  for (const file of files) {
    signal.throwIfAborted();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const clean = () => { signal.removeEventListener('abort', abort); reader.onload = reader.onerror = reader.onabort = null; };
      const abort = () => reader.abort();
      reader.onload = () => { const value = reader.result; clean(); typeof value === 'string' ? resolve(value) : reject(Error('Image read unavailable')); };
      reader.onerror = () => { clean(); reject(Error('Image read unavailable')); };
      reader.onabort = () => { clean(); reject(Error('Image read cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      try { reader.readAsDataURL(file); } catch (error) { clean(); reject(error); }
    });
    signal.throwIfAborted();
    media.push({ type: 'image', name: file.name, mimeType: file.type, size: file.size, dataUrl });
  }
  return copySharedMessageInput({ message: '', media }).media!;
}
