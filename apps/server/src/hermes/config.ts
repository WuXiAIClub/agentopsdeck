import { isAbsolute, parse } from 'node:path';

export type HermesConfig = {
  enabled: boolean; executable: string; sourceDirectory: string; homeDirectory: string;
  workspace: string; startupTimeoutMs: number;
};

export function hermesConfig(env: NodeJS.ProcessEnv): HermesConfig | undefined {
  if (env.AOD_HERMES_ENABLED !== 'true') return;
  const absolute = (name: string) => {
    const value = env[name];
    if (!value || !isAbsolute(value) || value === parse(value).root || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`${name} must be an absolute, non-root path`);
    }
    return value;
  };
  if (env.AOD_HERMES_DEDICATED !== 'true') throw new Error('Hermes requires AOD_HERMES_DEDICATED=true and an exclusively owned home');
  return { enabled: true, executable: absolute('AOD_HERMES_PYTHON'),
    sourceDirectory: absolute('AOD_HERMES_SOURCE'), homeDirectory: absolute('AOD_HERMES_HOME'),
    workspace: absolute('AOD_HERMES_WORKSPACE'), startupTimeoutMs: 30_000 };
}
