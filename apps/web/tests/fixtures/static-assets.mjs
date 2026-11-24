import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Serve only in-memory Vite build output. No dev client, filesystem fallback,
// proxy, WebSocket endpoint or application backend exists in this fixture.
export async function serveFixture(output) {
  const entries = output.filter(item => item.type === 'chunk' && item.isEntry);
  assert.equal(entries.length, 1);
  const assets = new Map(output.map(item => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  const styles = output.filter(item => item.fileName.endsWith('.css'));
  const html = '<!doctype html><html><head>' + styles.map(item => `<link rel="stylesheet" href="/${item.fileName}">`).join('')
    + `</head><body><div id="root"></div><script type="module" src="/${entries[0].fileName}"></script></body></html>`;
  const server = createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const body = path === '/fixture' ? html : assets.get(path);
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    const type = path === '/fixture' ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
