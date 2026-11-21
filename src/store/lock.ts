import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  minRetryMs?: number;
  maxRetryMs?: number;
}

interface LockMetadata {
  pid: number;
  token: string;
  createdAt: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_STALE_MS = 15_000;
const DEAD_PID_GRACE_MS = 1_500;

function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code?: unknown }).code);
  }
  return undefined;
}

function isTransientFsContention(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = getErrorCode(err);
    if (code === 'EPERM') {
      return true;
    }
    return false;
  }
}

async function tryEvictStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return false;
  }

  const ageMs = Date.now() - stat.mtimeMs;
  let shouldEvict = ageMs >= staleMs;

  if (!shouldEvict && ageMs >= Math.min(staleMs, DEAD_PID_GRACE_MS)) {
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LockMetadata>;
      if (typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid)) {
        shouldEvict = true;
      }
    } catch {
      // Ignore parse or transient read failure; age-based staleMs will handle if needed.
    }
  }

  if (!shouldEvict) {
    return false;
  }

  const trashPath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, trashPath);
  } catch {
    return false;
  }

  try {
    await fs.unlink(trashPath);
  } catch {
    // Best-effort cleanup of evicted lock file.
  }
  return true;
}

async function releaseLockFile(
  lockPath: string,
  token: string,
  acquiredAtMs: number,
  staleMs: number
): Promise<void> {
  // Only verify token ownership if the critical section ran long enough that
  // stale-lock eviction could plausibly have triggered.
  if (Date.now() - acquiredAtMs >= staleMs * 0.5) {
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LockMetadata>;
      if (parsed.token && parsed.token !== token) {
        return;
      }
    } catch (err) {
      if (getErrorCode(err) === 'ENOENT') {
        return;
      }
    }
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.unlink(lockPath);
      return;
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'ENOENT') {
        return;
      }
      if (isTransientFsContention(code) && attempt < 5) {
        await sleep(jitterMs(4, 15));
        continue;
      }
      throw err;
    }
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const minRetryMs = options.minRetryMs ?? 6;
  const maxRetryMs = options.maxRetryMs ?? 24;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let acquiredAtMs = 0;
  let acquired = false;

  while (!acquired) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      acquiredAtMs = Date.now();
      const metadata: LockMetadata = {
        pid: process.pid,
        token,
        createdAt: acquiredAtMs
      };
      try {
        await handle.writeFile(JSON.stringify(metadata), 'utf8');
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (err) {
      const code = getErrorCode(err);
      if (code !== 'EEXIST' && !isTransientFsContention(code)) {
        throw err;
      }

      if (code === 'EEXIST') {
        const evicted = await tryEvictStaleLock(lockPath, staleMs);
        if (evicted) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock after ${timeoutMs}ms: ${lockPath}`);
      }

      await sleep(jitterMs(minRetryMs, maxRetryMs));
    }
  }

  try {
    return await fn();
  } finally {
    await releaseLockFile(lockPath, token, acquiredAtMs, staleMs);
  }
}

export async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;

  const handle = await fs.open(tmpPath, 'wx');
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.datasync();
  } finally {
    await handle.close();
  }

  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rename(tmpPath, targetPath);
        return;
      } catch (err) {
        const code = getErrorCode(err);
        if (isTransientFsContention(code) && attempt < 9) {
          await sleep(jitterMs(5, 22));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup failure when rethrowing original write error.
    }
    throw err;
  }
}

export async function readJsonFile<T>(targetPath: string): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const raw = await fs.readFile(targetPath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'ENOENT') {
        return null;
      }
      if ((isTransientFsContention(code) || err instanceof SyntaxError) && attempt < 5) {
        await sleep(jitterMs(4, 16));
        continue;
      }
      throw err;
    }
  }
  return null;
}
