import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CodexAppServer } from './app-server.js';
import { CodexExecutions } from './executions.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';

test('original native startup receives only an opt-in base URL override and disposes the relay on close',
  { skip: process.platform === 'win32', timeout: 10000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-image-compat-startup-'));
    const database = new DatabaseSync(':memory:');
    const upstream = createServer(async (incoming, outgoing) => {
      let body = ''; for await (const chunk of incoming) body += chunk;
      const parsed = JSON.parse(body);
      assert.equal(parsed.input[2].type, 'message');
      outgoing.end('synthetic accepted');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address(); assert.ok(address && typeof address !== 'string');
    const command = join(directory, 'synthetic-codex');
    const captured = join(directory, 'arguments.json');
    await writeFile(command, `#!${process.execPath}\n
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
});
`, { mode: 0o700 });
    const options = { enabled: true, command, defaultCwd: directory, homeDirectory: directory,
      defaultModel: 'gemini-4-carbon', modelProvider: 'litellm', approvalPolicy: 'never' as const,
      toolImageCompatibility: { provider: 'litellm', upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1` },
      store: new DeckStore(), turnQueue: new TurnQueue(database), executions: new CodexExecutions(database),
      authorizeTurn: () => true };
    const codex = new CodexAppServer(options);
    try {
      await (codex as any).ensureStarted();
      const args: string[] = JSON.parse(await readFile(captured, 'utf8'));
      const override = args.find(value => value.startsWith('model_providers.litellm.base_url='));
      assert.ok(override);
      const baseUrl: string = JSON.parse(override.slice(override.indexOf('=') + 1));
      assert.equal(args.at(-1), 'app-server');
      assert.equal(args.filter(value => value.startsWith('model_providers.')).length, 1);
      const response = await fetch(`${baseUrl}/responses`, { method: 'POST', body: JSON.stringify({ model: 'gemini-4-carbon', input: [
        { type: 'function_call', call_id: 'synthetic', name: 'view_image', arguments: '{}' },
        { type: 'function_call_output', call_id: 'synthetic', output: [{ type: 'input_image', image_url: 'synthetic' }] },
      ] }) });
      assert.equal(await response.text(), 'synthetic accepted');
      await codex.close(); await assert.rejects(fetch(`${baseUrl}/models`));
      const mismatch = new CodexAppServer({ ...options, modelProvider: 'different-provider' });
      try { await assert.rejects((mismatch as any).ensureStarted(), /selected model provider/); }
      finally { await mismatch.close(); }
      const plain = new CodexAppServer({ ...options, toolImageCompatibility: undefined });
      try {
        await (plain as any).ensureStarted();
        const unchanged: string[] = JSON.parse(await readFile(captured, 'utf8'));
        assert.equal(unchanged.some(value => value.startsWith('model_providers.')), false);
      } finally { await plain.close(); }
    } finally {
      await codex.close(); database.close();
      const closing = new Promise<void>(resolve => upstream.close(() => resolve())); upstream.closeAllConnections(); await closing;
      await rm(directory, { recursive: true, force: true });
    }
  });
