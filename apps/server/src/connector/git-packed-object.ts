import { mkdtemp, mkdir, writeFile, symlink, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/** Git sees a disposable, config-free object database, not the user's repository.
 * Only the already-open pack directory is inherited. No alternates, refs, config,
 * hooks, filters, replacement objects, credentials or network configuration. */
export class PackedObjectReader {
  private constructor(private readonly directory: string, private readonly pack: FileHandle) {}
  static async create(pack: FileHandle) {
    const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-object-read-'));
    try {
      await mkdir(join(directory, 'objects'));
      await mkdir(join(directory, 'refs'));
      await writeFile(join(directory, 'HEAD'), 'ref: refs/heads/unused\n');
      await symlink('/proc/self/fd/3', join(directory, 'objects', 'pack'));
      return new PackedObjectReader(directory, pack);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async read(id: string, limit: number, timeout: number): Promise<Buffer> {
    if (!/^[a-f0-9]{40}$/.test(id) || limit < 128 || timeout <= 0) throw Error('object-budget');
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/git', ['--no-optional-locks', '--git-dir', this.directory, 'cat-file', '--batch'], {
        cwd: this.directory,
        env: { PATH: '/usr/bin:/bin', HOME: this.directory, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'ignore', this.pack.fd],
      });
      const chunks: Buffer[] = []; let bytes = 0, failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, Math.min(timeout, 2000));
      child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) stop(); else chunks.push(chunk); });
      child.on('error', () => { failed = true; });
      child.stdin!.on('error', () => { failed = true; });
      child.on('close', code => {
        clearTimeout(timer);
        if (failed || code !== 0) { reject(Error('packed-object-unavailable')); return; }
        const data = Buffer.concat(chunks), newline = data.indexOf(10);
        const header = new RegExp(`^${id} (blob|tree|commit) ([0-9]+)$`).exec(data.subarray(0, newline).toString('ascii'));
        if (!header || data.length !== newline + 2 + Number(header[2]) || data.at(-1) !== 10) { reject(Error('packed-object-invalid')); return; }
        resolve(Buffer.concat([Buffer.from(`${header[1]} ${header[2]}\0`), data.subarray(newline + 1, -1)]));
      });
      child.stdin!.end(`${id}\n`);
    });
  }
  async close() { await rm(this.directory, { recursive: true, force: true }); }
}
