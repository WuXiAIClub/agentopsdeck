import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { readPrivateWorkerCredential } from '../apps/server/src/connector/private-worker-credential.ts';
import { createToolImageCompatibilityRelay, rewriteGeminiToolImages } from '../apps/server/src/codex/tool-image-compat.ts';

if (process.env.AOD_GEMINI_COMPAT_PROBE !== '1' || !process.env.AOD_GEMINI_PROBE_KEY_FILE
  || !process.env.AOD_GEMINI_PROBE_BASE_URL || !process.env.AOD_GEMINI_PROBE_RECEIPT) {
  throw new Error('Explicit synthetic probe permission, private key file, upstream and new receipt path required');
}
const key = await readPrivateWorkerCredential(process.env.AOD_GEMINI_PROBE_KEY_FILE);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let current = index;
  for (let bit = 0; bit < 8; bit++) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});
function pngChunk(type, payload) {
  const name = Buffer.from(type);
  let checksum = 0xffffffff;
  for (const byte of Buffer.concat([name, payload])) checksum = crcTable[(checksum ^ byte) & 255] ^ (checksum >>> 8);
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length, 0); name.copy(result, 4); payload.copy(result, 8);
  result.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function syntheticImage(seed, shape) {
  const width = 1490, height = 1664;
  const raw = Buffer.alloc((width + 1) * height, 255);
  let state = seed;
  for (let row = 0; row < height; row++) {
    raw[row * (width + 1)] = 0;
    for (let column = 0; column < width; column++) {
      if (column < 407) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        raw[row * (width + 1) + column + 1] = state & 255;
      } else if (shape === 'square' ? Math.abs(column - 1050) <= 180 && Math.abs(row - 830) <= 180
        : (column - 1050) ** 2 + (row - 830) ** 2 <= 180 ** 2) {
        raw[row * (width + 1) + column + 1] = 0;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  return { url: `data:image/png;base64,${bytes.toString('base64')}`, byteLength: bytes.length, width, height };
}
const images = [syntheticImage(12345, 'square'), syntheticImage(67890, 'circle')];
const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text',
  text: 'This is a synthetic vision test. Each image has one large black geometric shape on the white area to the right of a noise strip. Name the two shapes in image order. Reply with shape names only. Never call tools.' }] }];
for (const [index, image] of images.entries()) input.push({ type: 'function_call', name: 'view_image',
  call_id: `call_synthetic_image_${index}`, arguments: JSON.stringify({ path: '/synthetic/fixture.png' }) });
for (const [index, image] of images.entries()) input.push({ type: 'function_call_output', call_id: `call_synthetic_image_${index}`,
  output: [{ type: 'input_image', image_url: image.url, detail: 'high' }] });
const body = { model: 'gemini-4-carbon', input, stream: true, store: false, tool_choice: 'none', tools: [
  { type: 'function', name: 'view_image', description: 'Synthetic fixture; do not invoke.', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  } },
] };
const before = JSON.stringify(body);
const rewritten = rewriteGeminiToolImages(body);
if (JSON.stringify(body) !== before || rewritten === body) throw new Error('Synthetic transformation invariant failed');
const lifted = rewritten.input.filter(item => item.type === 'message').flatMap(item => item.content)
  .filter(part => part.type === 'input_image');
const imagesUnchanged = lifted.length === 2 && lifted.every((part, index) => part.image_url === images[index].url && part.detail === 'high');
if (!imagesUnchanged) throw new Error('Synthetic image preservation invariant failed');
const upstream = process.env.AOD_GEMINI_PROBE_BASE_URL.replace(/\/$/, '');
const relay = await createToolImageCompatibilityRelay({ provider: 'litellm', upstreamBaseUrl: upstream });
const receipts = [];
try {
  for (const mode of ['before-direct', 'after-implemented-relay']) {
    const started = Date.now();
    let receipt;
    try {
      const response = await fetch(`${mode === 'before-direct' ? upstream : relay.baseUrl}/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: before, signal: AbortSignal.timeout(90000), redirect: 'error',
      });
      let content = '';
      for await (const chunk of response.body) {
        content += Buffer.from(chunk).toString('utf8');
        if (content.length > 256000) throw new Error('Synthetic response limit');
      }
      const events = content.split('\n').filter(line => line.startsWith('data: ')).flatMap(line => {
        try { return [JSON.parse(line.slice(6))]; } catch { return []; }
      });
      const text = events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta ?? '').join('').toLowerCase();
      const square = text.indexOf('square'), circle = text.indexOf('circle');
      receipt = { status: response.status, completed: events.some(event => event.type === 'response.completed'),
        failed: events.some(event => event.type === 'response.failed' || event.type === 'error'),
        invalidRequestBody: content.includes('invalid request body'),
        toolGenerated: events.some(event => /function_call|tool_call/.test(event.item?.type ?? '')),
        shapesReadInOrder: square >= 0 && circle > square };
    } catch (error) {
      receipt = { transportFailure: true, timeout: error.name === 'TimeoutError' };
    }
    receipt = { mode, timestamp: new Date().toISOString(), elapsedMs: Date.now() - started, ...receipt,
      requestBytes: Buffer.byteLength(mode === 'before-direct' ? before : JSON.stringify(rewritten)),
      images: images.map(({ byteLength, width, height }) => ({ byteLength, width, height })),
      imagesUnchanged, syntheticOnly: true, productionTouched: false, originalHistoryReplayed: false };
    receipts.push(receipt); console.log(JSON.stringify(receipt));
  }
} finally { await relay.close(); }
const passed = receipts[0]?.status === 400 && receipts[0]?.invalidRequestBody
  && receipts[1]?.status === 200 && receipts[1]?.completed && receipts[1]?.shapesReadInOrder
  && !receipts[1]?.failed && !receipts[1]?.toolGenerated;
await writeFile(process.env.AOD_GEMINI_PROBE_RECEIPT, JSON.stringify({ timestamp: new Date().toISOString(),
  maximumRequests: 2, actualRequests: receipts.length, passed, receipts }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
if (!passed) process.exitCode = 1;
