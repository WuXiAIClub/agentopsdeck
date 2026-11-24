import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readJsonBody } from './utils/http-body.js';

type Record = { digest: string; transcript: string; deliveryMode: string };
type Options = {
  directory?: string;
  transcribe?: (audio: Buffer, mime: string, signal: AbortSignal) => Promise<string>;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const worker = `
import sys,json,av
from faster_whisper import WhisperModel
file,model_name=sys.argv[1:3]
with av.open(file) as container:
    duration=(container.duration or 0)/av.time_base
    if duration <= 0 or duration > 65: raise ValueError('invalid audio duration')
model=WhisperModel(model_name,device='cpu',compute_type='int8',cpu_threads=2,local_files_only=True)
segments,info=model.transcribe(file,language='zh',vad_filter=True,beam_size=3,condition_on_previous_text=False)
text=''.join(s.text for s in segments if s.no_speech_prob < 0.6).strip()
print(json.dumps({'text':text},ensure_ascii=False),flush=True)
`;

export async function transcribeLocalAudio(audio: Buffer, mime: string, signal: AbortSignal): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-voice-'));
  const file = path.join(directory, mime === 'audio/mp4' ? 'recording.m4a' : mime === 'audio/wav' ? 'recording.wav' : 'recording.mp3');
  try {
    await writeFile(file, audio);
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.AOD_VOICE_PYTHON || 'python', ['-u', '-c', worker, file,
        process.env.AOD_VOICE_MODEL || 'small'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let output = '', failure: Error | undefined;
      const abort = () => { failure = new Error('voice_cancelled'); child.kill(); };
      const timer = setTimeout(() => { failure = new Error('voice_transcription_timeout'); child.kill(); }, 120_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on('data', data => {
        output += String(data);
        if (output.length > 64_000) { failure = new Error('voice_output_too_large'); child.kill(); }
      });
      child.stderr.resume();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.on('error', () => { cleanup(); reject(new Error('voice_python_unavailable')); });
      child.on('close', code => {
        cleanup();
        if (failure || code !== 0) { reject(failure ?? new Error('voice_transcription_failed')); return; }
        try { resolve(String(JSON.parse(output.trim()).text ?? '').trim()); }
        catch { reject(new Error('voice_transcription_failed')); }
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function registerVoiceMessages(app: Hono, options: Options = {}) {
  const directory = options.directory ?? process.env.AOD_VOICE_STATE_DIR ?? path.join(homedir(), '.agentopsdeck', 'voice-receipts');
  const transcribe = options.transcribe ?? transcribeLocalAudio;
  const active = new Set<string>();
  let inputs = 0;
  let transcribing = false;
  app.use('/api/*', async (context, next) => {
    const matched = /^(\/api\/(?:hub\/v1\/)?(?:shared\/[^/]+\/)?sessions\/[^/]+)\/voice$/.exec(context.req.path);
    if (!matched || context.req.method !== 'POST') return next();
    context.header('Cache-Control', 'no-store');
    const original = context.req.raw;
    const sessionPath = matched[1]!;
    const headers = new Headers(original.headers);
    for (const name of ['content-type', 'content-length', 'idempotency-key', 'if-none-match', 'if-match',
      'x-agentopsdeck-history-delta', 'x-agentopsdeck-history-async']) headers.delete(name);
    const requestFor = (suffix: string, init: RequestInit = {}) => new Request(new URL(sessionPath + suffix, original.url),
      { headers, signal: original.signal, ...init });
    const authorize = async (mode = 'web-only') => {
      const response = await app.fetch(requestFor('/messages?limit=1'));
      if (!response.ok) return response;
      await response.body?.cancel();
      if (/\/shared\//.test(sessionPath)) {
        const admission = await app.fetch(requestFor(`/voice/admission?deliveryMode=${encodeURIComponent(mode)}`, { method: 'POST' }));
        if (!admission.ok) return admission;
        await admission.body?.cancel();
      }
      return undefined;
    };
    const denied = await authorize();
    if (denied) return denied;
    if (process.env.AOD_VOICE_ENABLED === 'false') return context.json({ error: 'voice_disabled' }, 503);
    if (inputs >= 4) return context.json({ error: 'voice_capacity_exceeded' }, 503);
    inputs++;
    let locked: string | undefined;
    try {
      const body = await readJsonBody(original, 3 * 1024 * 1024) as {
        audio?: { contentBase64?: unknown; mimeType?: unknown }; idempotencyKey?: unknown; deliveryMode?: unknown;
      } | null;
      const key = body?.idempotencyKey, mime = body?.audio?.mimeType, base64 = body?.audio?.contentBase64;
      const mode = body?.deliveryMode ?? 'web-only';
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)
        || typeof mime !== 'string' || !['audio/mp4', 'audio/wav', 'audio/mpeg'].includes(mime)
        || typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
        || !['web-only', 'mirror'].includes(String(mode))) return context.json({ error: 'invalid_voice_request' }, 400);
      const audio = Buffer.from(base64, 'base64');
      if (audio.length < 64 || audio.length > 2 * 1024 * 1024) return context.json({ error: 'invalid_voice_size' }, 400);
      const forbidden = await authorize(String(mode));
      if (forbidden) return forbidden;
      const credential = ['authorization', 'cookie', 'x-agentopsdeck-key', 'x-agentopsdeck-key']
        .map(name => original.headers.get(name) ?? '').join('\n');
      const identity = hash(credential + '\n' + sessionPath + '\n' + key);
      if (active.has(identity)) return context.json({ error: 'voice_request_in_progress' }, 409);
      active.add(identity); locked = identity;
      const recordPath = path.join(directory, identity + '.json');
      const digest = hash(audio);
      let record: Record | undefined;
      try { record = JSON.parse(await readFile(recordPath, 'utf8')) as Record; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (record && (record.digest !== digest || record.deliveryMode !== mode))
        return context.json({ error: 'voice_request_conflict' }, 409);
      if (!record) {
        if (transcribing) return context.json({ error: 'voice_transcription_busy' }, 503);
        transcribing = true;
        let transcript: string;
        try { transcript = (await transcribe(audio, mime, original.signal)).trim(); }
        finally { transcribing = false; }
        if (!transcript) return context.json({ error: 'voice_no_speech' }, 422);
        if (transcript.length > 16_000) return context.json({ error: 'voice_text_too_long' }, 422);
        if (transcript.startsWith('/')) return context.json({ error: 'voice_control_not_allowed' }, 422);
        const changed = await authorize(String(mode));
        if (changed) return changed;
        record = { digest, transcript, deliveryMode: String(mode) };
        await mkdir(directory, { recursive: true });
        const temporary = recordPath + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, recordPath);
      }
      original.signal.throwIfAborted();
      const revoked = await authorize(String(mode));
      if (revoked) return revoked;
      const sendingHeaders = new Headers(headers);
      sendingHeaders.set('content-type', 'application/json');
      const response = await app.fetch(requestFor('/messages', { method: 'POST', headers: sendingHeaders,
        body: JSON.stringify({ message: record.transcript, deliveryMode: record.deliveryMode, media: [], idempotencyKey: key }) }));
      return response;
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (original.signal.aborted) return context.json({ error: 'voice_cancelled' }, 408);
      return context.json({ error: error instanceof Error && /^voice_[a-z_]+$/.test(error.message)
        ? error.message : 'voice_processing_failed' }, 503);
    } finally { if (locked) active.delete(locked); inputs--; }
  });
}
