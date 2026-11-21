import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { NotFoundError, RelayStore } from '../src/index.js';

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

describe('RelayStore channels, cooperative leases, and async human inbox', () => {
  it('supports channel cursor pagination, tailing, and channel summaries', async () => {
    const baseDir = await makeTempDir('agent-relay-store-');
    const store = new RelayStore({ baseDir });

    const empty = await store.readMessages({ channel: 'backend' });
    assert.equal(empty.headSeq, 0);
    assert.deepEqual(empty.messages, []);

    for (let i = 1; i <= 5; i += 1) {
      const posted = await store.postMessage({
        channel: 'backend',
        sender: `worker-${i}`,
        body: `Step ${i} completed`,
        tags: ['progress', 'progress']
      });
      assert.equal(posted.headSeq, i);
      assert.equal(posted.message.seq, i);
      assert.deepEqual(posted.message.tags, ['progress']);
    }

    const page1 = await store.readMessages({ channel: 'backend', sinceSeq: 0, limit: 2 });
    assert.equal(page1.headSeq, 5);
    assert.equal(page1.hasMore, true);
    assert.deepEqual(
      page1.messages.map((m) => m.seq),
      [1, 2]
    );

    const page2 = await store.readMessages({ channel: 'backend', sinceSeq: 2, limit: 2 });
    assert.equal(page2.hasMore, true);
    assert.deepEqual(
      page2.messages.map((m) => m.seq),
      [3, 4]
    );

    const page3 = await store.readMessages({ channel: 'backend', sinceSeq: 4, limit: 2 });
    assert.equal(page3.hasMore, false);
    assert.deepEqual(
      page3.messages.map((m) => m.seq),
      [5]
    );

    const tail = await store.tailMessages({ channel: 'backend', limit: 2 });
    assert.deepEqual(
      tail.messages.map((m) => m.seq),
      [4, 5]
    );

    const channels = await store.listChannels();
    assert.equal(channels.length, 1);
    assert.equal(channels[0]?.channel, 'backend');
    assert.equal(channels[0]?.headSeq, 5);
    assert.equal(channels[0]?.messageCount, 5);
  });

  it('enforces exclusive cooperative file leases, owner renewal, conflict reporting, and TTL expiry', async () => {
    const baseDir = await makeTempDir('agent-relay-lease-');
    let clockMs = Date.parse('2026-11-21T10:00:00.000Z');
    const store = new RelayStore({
      baseDir,
      now: () => clockMs
    });

    const first = await store.acquireFileLease({
      path: './src\\api/routes.ts',
      owner: 'session-alpha',
      ttlSeconds: 60
    });
    assert.equal(first.acquired, true);
    assert.equal(first.renewed, false);
    assert.equal(first.path, 'src/api/routes.ts');
    assert.equal(first.holder, 'session-alpha');
    assert.equal(first.expiresAt, '2026-11-21T10:01:00.000Z');

    clockMs += 20_000;
    const conflict = await store.acquireFileLease({
      path: 'src/api/routes.ts',
      owner: 'session-beta',
      ttlSeconds: 120
    });
    assert.equal(conflict.acquired, false);
    assert.equal(conflict.holder, 'session-alpha');
    assert.equal(conflict.expiresAt, '2026-11-21T10:01:00.000Z');

    const deniedRelease = await store.releaseFileLease({
      path: 'src/api/routes.ts',
      owner: 'session-beta'
    });
    assert.equal(deniedRelease.released, false);
    assert.equal(deniedRelease.holder, 'session-alpha');

    const renewed = await store.acquireFileLease({
      path: 'src/api/routes.ts',
      owner: 'session-alpha',
      ttlSeconds: 90
    });
    assert.equal(renewed.acquired, true);
    assert.equal(renewed.renewed, true);
    assert.equal(renewed.acquiredAt, '2026-11-21T10:00:00.000Z');
    assert.equal(renewed.expiresAt, '2026-11-21T10:01:50.000Z');

    clockMs = Date.parse('2026-11-21T10:01:51.000Z');
    const takenAfterExpiry = await store.acquireFileLease({
      path: 'src/api/routes.ts',
      owner: 'session-beta',
      ttlSeconds: 30
    });
    assert.equal(takenAfterExpiry.acquired, true);
    assert.equal(takenAfterExpiry.renewed, false);
    assert.equal(takenAfterExpiry.holder, 'session-beta');

    const released = await store.releaseFileLease({
      path: 'src/api/routes.ts',
      owner: 'session-beta'
    });
    assert.equal(released.released, true);
    assert.equal(released.alreadyExpiredOrMissing, false);

    const idempotentRelease = await store.releaseFileLease({
      path: 'src/api/routes.ts',
      owner: 'session-beta'
    });
    assert.equal(idempotentRelease.released, true);
    assert.equal(idempotentRelease.alreadyExpiredOrMissing, true);
  });

  it('queues non-blocking human questions and records operator replies', async () => {
    const baseDir = await makeTempDir('agent-relay-inbox-');
    const store = new RelayStore({ baseDir });

    const queued = await store.askHumanAsync({
      sender: 'refactor-agent',
      question: 'Which migration strategy should be used for users table?',
      options: ['expand-contract', 'in-place'],
      priority: 'high'
    });

    assert.equal(queued.status, 'pending');
    assert.equal(queued.answer, null);
    assert.equal(queued.answeredAt, null);
    assert.match(queued.questionId, /^q_[a-z0-9]+_[a-f0-9]{8}$/);

    const checkPending = await store.checkHumanReply({ questionId: queued.questionId });
    assert.equal(checkPending.status, 'pending');
    assert.equal(checkPending.answer, null);

    const pendingBefore = await store.listQuestions({ includeAnswered: false });
    assert.equal(pendingBefore.length, 1);

    const answered = await store.answerHumanQuestion({
      questionId: queued.questionId,
      answer: 'Use expand-contract with zero-downtime backfill.'
    });
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answer, 'Use expand-contract with zero-downtime backfill.');
    assert.ok(answered.answeredAt);

    const checkAfter = await store.checkHumanReply({ questionId: queued.questionId });
    assert.equal(checkAfter.status, 'answered');
    assert.equal(checkAfter.answer, 'Use expand-contract with zero-downtime backfill.');

    const pendingAfter = await store.listQuestions({ includeAnswered: false });
    assert.equal(pendingAfter.length, 0);

    const allAfter = await store.listQuestions({ includeAnswered: true });
    assert.equal(allAfter.length, 1);

    await assert.rejects(
      () => store.checkHumanReply({ questionId: 'q_missing_00000000' }),
      NotFoundError
    );
  });

  it('handles Object.prototype property names cleanly in file leases without prototype collisions', async () => {
    const baseDir = await makeTempDir('agent-relay-proto-');
    const store = new RelayStore({ baseDir });
    const protoKeys = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

    for (const key of protoKeys) {
      const acquired = await store.acquireFileLease({
        path: key,
        owner: 'owner-a',
        ttlSeconds: 120
      });
      assert.equal(acquired.acquired, true, `Failed to acquire "${key}"`);
      assert.equal(acquired.renewed, false);
      assert.equal(acquired.holder, 'owner-a');

      const conflict = await store.acquireFileLease({
        path: key,
        owner: 'owner-b',
        ttlSeconds: 120
      });
      assert.equal(conflict.acquired, false, `Expected conflict on "${key}"`);
      assert.equal(conflict.holder, 'owner-a');
    }

    // Reload via fresh RelayStore instance to verify disk serialization & deserialization of "__proto__"
    const reloadedStore = new RelayStore({ baseDir });
    const listed = await reloadedStore.listActiveLeases();
    assert.equal(listed.length, protoKeys.length);

    for (const key of protoKeys) {
      const released = await reloadedStore.releaseFileLease({
        path: key,
        owner: 'owner-a'
      });
      assert.equal(released.released, true, `Failed to release "${key}"`);
      assert.equal(released.alreadyExpiredOrMissing, false);
    }

    const afterRelease = await reloadedStore.listActiveLeases();
    assert.equal(afterRelease.length, 0);
  });

  it('shares lease locks across casing variants when caseInsensitivePaths is enabled', async () => {
    const baseDir = await makeTempDir('agent-relay-case-');
    const ciStore = new RelayStore({ baseDir, caseInsensitivePaths: true });

    const first = await ciStore.acquireFileLease({
      path: 'src/FooComponent.ts',
      owner: 'agent-1',
      ttlSeconds: 120
    });
    assert.equal(first.acquired, true);
    assert.equal(first.path, 'src/FooComponent.ts');

    const conflict = await ciStore.acquireFileLease({
      path: 'src/foocomponent.ts',
      owner: 'agent-2',
      ttlSeconds: 120
    });
    assert.equal(conflict.acquired, false);
    assert.equal(conflict.holder, 'agent-1');

    const renewed = await ciStore.acquireFileLease({
      path: 'SRC/FOOCOMPONENT.TS',
      owner: 'agent-1',
      ttlSeconds: 180
    });
    assert.equal(renewed.acquired, true);
    assert.equal(renewed.renewed, true);

    const released = await ciStore.releaseFileLease({
      path: 'src/foocomponent.ts',
      owner: 'agent-1'
    });
    assert.equal(released.released, true);
    assert.equal(released.alreadyExpiredOrMissing, false);
  });
});
