// Safety instrumentation only: never simulates an application response or
// rewrites a bind address. The shipped index.js must bind itself correctly.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  // Emit even if application code catches the exception; harness treats marker
  // as failure. No target, arguments, credentials or payloads reach logs.
  process.stderr.write('INSTALL_BOUNDARY forbidden egress/native operation\n');
  throw new Error('INSTALL_BOUNDARY forbidden egress/native operation');
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[0] !== 0 || args[1] !== '127.0.0.1') return deny();
  this.once('listening', () => {
    const address = this.address();
    if (address.address !== '127.0.0.1') return deny();
    console.log('AOD_TEST_LISTENER ' + JSON.stringify(address));
  });
  return Reflect.apply(listen, this, args);
};
net.Socket.prototype.connect = deny;
tls.connect = deny;
dgram.createSocket = deny;
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (host !== '127.0.0.1') return deny();
  return Reflect.apply(lookup, dns, [host, ...args]);
};
dns.promises.lookup = deny;
for (const key of ['resolve', 'resolve4', 'resolve6', 'reverse']) {
  dns[key] = deny;
  dns.promises[key] = deny;
}
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = deny;
syncBuiltinESMExports();
