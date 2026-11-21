import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RelayStore, withFileLock } from '../src/index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function spawnWorkerProcess(
  workerScript: string,
  args: string[]
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, ...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });
}

describe('cross-process file locking and atomic writes', () => {
  it('preserves monotonic sequence integrity across 8 concurrent OS processes', async () => {
    const baseDir = await makeTempDir('agent-relay-mp-');
    const currentFile = fileURLToPath(import.meta.url);
    const workerScript = path.join(path.dirname(currentFile), 'helpers', 'workerWriter.js');

    const workerCount = 8;
    const messagesPerWorker = 12;
    const expectedTotal = workerCount * messagesPerWorker;
    const channel = 'concurrent_build';

    const tasks = Array.from({ length: workerCount }, (_, idx) =>
      spawnWorkerProcess(workerScript, [
        baseDir,
        `agent-${idx + 1}`,
        channel,
        String(messagesPerWorker)
      ])
    );

    const results = await Promise.all(tasks);
    for (const res of results) {
      assert.equal(res.code, 0, `Worker failed with stderr: ${res.stderr}`);
    }

    const store = new RelayStore({ baseDir });
    const readRes = await store.readMessages({
      channel,
      sinceSeq: 0,
      limit: 500
    });

    assert.equal(readRes.headSeq, expectedTotal);
    assert.equal(readRes.messages.length, expectedTotal);

    for (let i = 0; i < expectedTotal; i += 1) {
      const msg = readRes.messages[i];
      assert.ok(msg);
      assert.equal(msg.seq, i + 1);
    }

    const perWorkerCounts = new Map<string, number>();
    for (const msg of readRes.messages) {
      perWorkerCounts.set(msg.sender, (perWorkerCounts.get(msg.sender) ?? 0) + 1);
    }
    assert.equal(perWorkerCounts.size, workerCount);
    for (const [, count] of perWorkerCounts) {
      assert.equal(count, messagesPerWorker);
    }

    const activeLeases = await store.listActiveLeases();
    assert.equal(activeLeases.length, 0);

    const lockEntries = await fs.readdir(path.join(baseDir, 'locks'));
    assert.equal(lockEntries.length, 0);
  });

  it('recovers automatically from a stale crashed-process lock file', async () => {
    const baseDir = await makeTempDir('agent-relay-stale-');
    const lockPath = path.join(baseDir, 'locks', 'stale-test.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 99999999, token: 'crashed-token', createdAt: Date.now() - 60_000 }),
      'utf8'
    );
    const pastDate = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, pastDate, pastDate);

    let executed = false;
    const value = await withFileLock(
      lockPath,
      async () => {
        executed = true;
        return 42;
      },
      { staleMs: 100, timeoutMs: 3_000 }
    );

    assert.equal(executed, true);
    assert.equal(value, 42);
    await assert.rejects(() => fs.stat(lockPath), { code: 'ENOENT' });
  });
});
