import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function boundedArchiveTransfer(args, file, maxBytes, timeout = 190_000, options = {}) {
  const existing = await lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  assert.ok(!existing || existing.isFile(), 'Archive must be a regular file');
  const offset = existing?.size ?? 0;
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && offset < maxBytes, 'Archive byte budget exhausted');
  const outputIndex = args.indexOf('--output');
  assert.ok(outputIndex >= 0 && args[outputIndex + 1] === file, 'Archive output must match its owned path');
  const boundedArgs = [...args];
  boundedArgs[outputIndex + 1] = '-';
  const resumeIndex = boundedArgs.indexOf('--continue-at');
  if (resumeIndex >= 0) boundedArgs[resumeIndex + 1] = String(offset);
  else assert.equal(offset, 0, 'Non-resumable archive must be empty');
  const child = (options.spawn ?? spawn)('curl', boundedArgs, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  let received = offset;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new Error('Archive exceeds its transfer byte bound'));
      else callback(null, chunk);
    },
  });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ error, status: null, signal: null }));
    child.once('close', (status, signal) => resolve({ status: timedOut ? 28 : status, signal: timedOut ? null : signal }));
  });
  try {
    await pipeline(child.stdout, limiter, createWriteStream(file, { flags: existing ? 'a' : 'wx', mode: 0o600 }));
    return await completion;
  } catch (error) {
    child.kill('SIGKILL');
    await completion;
    await rm(file, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
