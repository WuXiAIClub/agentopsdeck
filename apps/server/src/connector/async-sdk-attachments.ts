import { createHash } from 'node:crypto';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import { SDK_ATTACHMENT_CHUNK_BYTES } from './sdk-attachment-store.js';
import { validateSdkAttachments, type SdkInputAttachment } from './sdk-attachment-input.js';
import { validConnectorSdkAttachmentOutput } from './connector-sdk-attachment-domain.js';

// Shared across both SDK dispatchers in this process. Keep reservations through
// native ACK, not merely until the last SQL read; never queue unbounded bodies.
const ASSEMBLY_BUDGET = 40 * 1024 * 1024;
let reservedBytes = 0;
export function reserveSdkAttachmentAssembly(bytes: number): () => void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || reservedBytes + bytes > ASSEMBLY_BUDGET) throw Error('connector_storage_unavailable');
  reservedBytes += bytes;
  let held = true;
  return () => { if (held) { held = false; reservedBytes -= bytes; } };
}

/** Sequential bounded reads; no body in queue/receipt/log and no native effect.
 * The final manifest read rechecks authority after all cross-thread awaits. */
export async function readSdkExecutionAttachments(owner: Pick<AsyncConnectorOwner, 'command'>, runtime: SdkAgentId,
  ref: SdkCompactRef, available: () => boolean, reserve: (bytes: number) => void): Promise<SdkInputAttachment[]> {
  const check = () => { if (!available()) throw Error('connector_storage_unavailable'); };
  const sameRef = (actual: SdkCompactRef) => Object.entries(ref).every(([k, v]) => actual[k as keyof SdkCompactRef] === v);
  check();
  const manifest = await owner.command('sdkExecutionAttachmentManifest', { runtime, ref });
  check();
  if (!validConnectorSdkAttachmentOutput('sdkExecutionAttachmentManifest', manifest) || !sameRef(manifest.ref)) throw Error('connector_storage_unavailable');
  reserve(manifest.items.reduce((total, item) => total + item.size, 0));
  const items: SdkInputAttachment[] = [];
  for (const item of manifest.items) {
    const parts: Buffer[] = [], hash = createHash('sha256');
    for (let offset = 0; offset < item.size; offset += SDK_ATTACHMENT_CHUNK_BYTES) {
      check();
      const chunk = await owner.command('sdkExecutionAttachmentChunk', { runtime, ref, admissionId: item.admissionId, id: item.id, offset, size: item.size });
      check();
      if (!validConnectorSdkAttachmentOutput('sdkExecutionAttachmentChunk', chunk) || !sameRef(chunk.ref)
        || chunk.admissionId !== item.admissionId || chunk.id !== item.id || chunk.offset !== offset || chunk.size !== item.size) throw Error('connector_storage_unavailable');
      const body = Buffer.from(chunk.data, 'base64'); hash.update(body); parts.push(body);
    }
    if (hash.digest('hex') !== item.sha256) throw Error('connector_storage_unavailable');
    items.push({ name: item.name, mimeType: item.mimeType, data: Buffer.concat(parts, item.size).toString('base64') });
  }
  validateSdkAttachments(items);
  check();
  const final = await owner.command('sdkExecutionAttachmentManifest', { runtime, ref });
  check();
  if (!validConnectorSdkAttachmentOutput('sdkExecutionAttachmentManifest', final) || !sameRef(final.ref)
    || JSON.stringify(final.items) !== JSON.stringify(manifest.items)) throw Error('connector_storage_unavailable');
  return items;
}
