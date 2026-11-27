import { win32 } from 'node:path';

export function ahpConfig(env: NodeJS.ProcessEnv, platform = process.platform) {
  const instanceId = env.AOD_AHP_INSTANCE_ID;
  const sessionUri = env.AOD_AHP_SESSION_URI;
  const cli = env.AOD_AHP_VSCODE_CLI;
  if (instanceId === undefined && sessionUri === undefined && cli === undefined) return;
  if (platform !== 'win32' || !instanceId || !/^[A-Za-z0-9_-]{16,256}$/.test(instanceId)
    || !sessionUri || !/^ahp-session:\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionUri)
    || !cli || !/^[a-z]:\\/i.test(cli) || win32.basename(cli).toLowerCase() !== 'code-tunnel.exe') {
    throw new Error('AOD AHP requires a Windows VS Code CLI, editor instance ID and exact session URI');
  }
  return { instanceId, sessionUri, cli };
}

export type AhpConfig = NonNullable<ReturnType<typeof ahpConfig>>;
