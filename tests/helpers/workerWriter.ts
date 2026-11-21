import { RelayStore } from '../../src/index.js';

async function runWorker(): Promise<void> {
  const baseDir = process.argv[2];
  const workerId = process.argv[3];
  const channel = process.argv[4];
  const count = Number.parseInt(process.argv[5] ?? '10', 10);

  if (!baseDir || !workerId || !channel) {
    throw new Error('Missing worker arguments.');
  }

  const store = new RelayStore({ baseDir, lockTimeoutMs: 20_000 });

  for (let i = 0; i < count; i += 1) {
    await store.postMessage({
      channel,
      sender: workerId,
      body: `message-${workerId}-${i}`,
      tags: ['stress', workerId]
    });

    if (i % 3 === 0) {
      const lease = await store.acquireFileLease({
        path: 'src/shared-target.ts',
        owner: workerId,
        ttlSeconds: 60
      });
      if (lease.acquired) {
        await store.releaseFileLease({
          path: 'src/shared-target.ts',
          owner: workerId
        });
      }
    }
  }
}

runWorker().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
