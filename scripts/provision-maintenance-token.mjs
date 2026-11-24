// Local operator provisioning. Uses an inherited access key, never a key argument.
// No retries: an ambiguous POST must be reconciled by its unique label first.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function provisionMaintenanceToken({ origin, nodeId, file, label, accessKey, request = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || !isAbsolute(file) || resolve(file) !== file || !accessKey
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(nodeId) || !label || label.length > 256) throw new Error('Invalid local provisioning configuration');
  const parent = await lstat(dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
    || (parent.mode & 0o077) || await realpath(dirname(file)) !== dirname(file)) throw new Error('Private credential directory required');
  // Reserve the destination before minting. An empty file after failure is an
  // explicit unresolved attempt; do not overwrite it or blindly mint again.
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const call = (path, body) => request(`${url.origin}/api/connector/v1/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json',
        'x-agentopsdeck-protocol': '1', 'x-agentopsdeck-expected-node-id': nodeId },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const list = await call('tokens');
    if (list.status !== 200) throw new Error('Operator token provisioning is not authorized');
    const existing = await list.json();
    if (!Array.isArray(existing.tokens) || existing.tokens.some(token => token.label === label && !token.revokedAt)) {
      throw new Error('Existing provisioning label: reconcile without retry');
    }
    const response = await call('tokens', { label, scopes: ['connector:lifecycle'] });
    if (response.status !== 201) throw new Error('Provisioning outcome requires operator reconciliation');
    const issued = await response.json();
    if (typeof issued.token !== 'string' || !/^aod_conn_[A-Za-z0-9_-]+$/.test(issued.token)
      || issued.record?.scopes?.join(',') !== 'connector:lifecycle') throw new Error('Invalid provisioning receipt');
    await handle.writeFile(`${issued.token}\n`); await handle.sync();
    const directory = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    return { tokenId: issued.record.id, scopes: issued.record.scopes, credentialStored: true };
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 6) throw new Error('Expected origin, node ID, private destination, label');
    console.log(JSON.stringify(await provisionMaintenanceToken({ origin: process.argv[2], nodeId: process.argv[3],
      file: process.argv[4], label: process.argv[5], accessKey: process.env.AOD_ACCESS_KEY })));
  } catch { console.error('Maintenance provisioning did not complete; reconcile the original label before retrying. No credentials printed.'); process.exitCode = 1; }
}
