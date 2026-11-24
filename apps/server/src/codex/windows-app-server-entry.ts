import { spawn } from 'node:child_process';
import { windowsCommand } from './windows-command.js';
import { defaultModeQuestionFeature, probeDefaultModeQuestions } from './interaction-capability.js';

/** Dormant until the Connector has assigned this exact process to its job.
 * IPC is control-only; stdout/stderr/stdin retain the native JSON-RPC transport.
 * Parent death before assignment exits without creating native descendants. */
if (process.platform !== 'win32' || !process.send) throw new Error('Windows bootstrap requires IPC');
let launched = false;
process.once('disconnect', () => process.exit(1));
process.once('message', async (value: { kind?: unknown; command?: unknown; args?: unknown; cwd?: unknown; env?: NodeJS.ProcessEnv; questions?: boolean }) => {
  if (launched || value?.kind !== 'launch' || typeof value.command !== 'string' || !value.command.trim() ||
    typeof value.cwd !== 'string' || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string') || !value.env) process.exit(1);
  launched = true;
  const args = value.args as string[], command = value.command as string;
  try {
    // Even read-only CLI probes run inside the assigned job. Timeout exit of a
    // shell is not drain proof; the guardian owns remaining descendants too.
    const supported = !!value.questions && await probeDefaultModeQuestions(command, value.cwd as string, value.env.CODEX_HOME, value.env);
    if (!process.connected) process.exit(1);
    process.send!({ kind: 'features', supported });
    const invocation = windowsCommand(command, supported ? ['--enable', defaultModeQuestionFeature, ...args] : args);
    const child = spawn(invocation.command, invocation.args, { cwd: value.cwd as string, env: value.env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments, windowsHide: true, stdio: 'pipe' });
    child.on('error', () => process.exit(1));
    process.stdin.pipe(child.stdin); child.stdin.on('error', () => {});
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.once('close', code => process.exit(code ?? 1));
  } catch { process.exit(1); }
});
process.send({ kind: 'bootstrap-ready' });
