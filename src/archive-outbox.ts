import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One process owns this directory (systemd). Every event is durable before any
// Supabase/R2 work, and is removed only after the message transaction succeeds.
export class ArchiveOutbox<T> {
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly directory: string, readonly save: (value: T) => Promise<void>) {}
  async enqueue(value: T): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = path.join(this.directory, `${Date.now()}-${randomUUID()}.json`);
    const file = await open(`${name}.tmp`, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(`${name}.tmp`, name);
    await this.syncDirectory();
  }
  drain(limit = 25): Promise<void> {
    const run = this.tail.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const files = (await readdir(this.directory)).filter(f => /^\d+-[a-f0-9-]+\.json$/.test(f)).sort().slice(0, limit);
      for (const file of files) {
        const name = path.join(this.directory, file);
        // A corrupt entry stops the batch and remains available for diagnosis.
        const value = JSON.parse(await readFile(name, 'utf8')) as T;
        await this.save(value);
        await unlink(name); await this.syncDirectory();
      }
    });
    this.tail = run; return run;
  }
  private async syncDirectory(): Promise<void> {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
