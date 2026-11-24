// Run with the repository's TypeScript loader. No production paths or tokens.
import { runHistorySoak } from '../apps/server/src/storage/history-soak.ts';
const minutes = Number(process.argv[2] ?? '120');
const checkpoint = process.argv[3] ?? 'passive';
if (![2, 120, 480].includes(minutes) || !['none', 'passive'].includes(checkpoint)) throw Error('Usage: history-soak.mjs [2|120|480] [none|passive]');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
const result = await runHistorySoak({ durationMs: minutes * 60_000, checkpoint }, sample => console.log(JSON.stringify({ sample })), controller.signal);
console.log(JSON.stringify({ result }));
if (result.stopped !== 'duration-budget') process.exitCode = 1;
