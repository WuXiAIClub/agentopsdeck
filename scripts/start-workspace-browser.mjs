// Run ONLY inside an independently isolated browser runtime, never as the Hub
// service user. The opt-in below asserts an external policy; it installs none.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function runtimeOptions(env, uid) {
  if (env.AOD_BROWSER_EGRESS_ISOLATED !== 'true' || !Number.isSafeInteger(uid) || uid <= 0) {
    throw Error('An isolated, public-egress-only runtime and a non-root user are required');
  }
  const port = Number(env.AOD_BROWSER_RUNTIME_PORT || 9324);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid browser runtime port');
  return { headless: true, chromiumSandbox: true, host: '127.0.0.1', port, wsPath: '/agentopsdeck-browser' };
}

export async function main() {
  const options = runtimeOptions(process.env, process.getuid?.());
  const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const { chromium } = require('playwright-core');
  const server = await chromium.launchServer(options);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000); deadline.unref();
    void server.close().then(() => { clearTimeout(deadline); }, () => process.exit(1));
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  console.log(`Isolated browser runtime ready on loopback port ${options.port}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Browser runtime failed. Verify isolation, non-root Chromium sandbox support and the matching browser installation.'); process.exitCode = 1; });
}
