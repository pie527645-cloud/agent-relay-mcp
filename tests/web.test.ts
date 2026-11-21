import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { RelayStore, RunningWebServer, startRelayWebServer } from '../src/index.js';

const tempDirs: string[] = [];
const runningServers: RunningWebServer[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const srv = runningServers.pop();
    if (srv) {
      await srv.close();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function rawHttpRequest(options: {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('local web dashboard security and reply handling', () => {
  it('binds strictly to 127.0.0.1, escapes XSS payloads across all fields, and sets CSP', async () => {
    const baseDir = await makeTempDir('agent-relay-web-xss-');
    const store = new RelayStore({ baseDir });

    await store.postMessage({
      channel: 'sec_test',
      sender: 'agent"><script>alert(1)</script>',
      body: '<img src=x onerror="alert(2)"> & </textarea><script>evil()</script>',
      tags: ['tag<svg onload=alert(3)>']
    });

    await store.acquireFileLease({
      path: 'src/weird<name>.ts',
      owner: 'owner"><script>alert(4)</script>',
      ttlSeconds: 300
    });

    await store.askHumanAsync({
      sender: 'asker<script>alert(5)</script>',
      question: 'Approve </pre><script>alert(6)</script>?',
      options: ['yes"><script>alert(7)</script>'],
      priority: 'urgent'
    });

    const web = await startRelayWebServer({ store, port: 0 });
    runningServers.push(web);
    assert.equal(web.host, '127.0.0.1');

    const res = await rawHttpRequest({
      port: web.port,
      headers: { Host: `127.0.0.1:${web.port}` }
    });

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-security-policy'] ?? ''), /default-src 'none'/);

    assert.equal(res.body.includes('<script>'), false);
    assert.equal(res.body.includes('<img src=x'), false);
    assert.equal(res.body.includes('<svg onload'), false);
    assert.equal(res.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
    assert.equal(res.body.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'), true);
    assert.equal(res.body.includes('&lt;svg onload=alert(3)&gt;'), true);
  });

  it('returns HTTP 403 on untrusted Host, Origin, Referer, or cross-site Sec-Fetch-Site headers', async () => {
    const baseDir = await makeTempDir('agent-relay-web-403-');
    const store = new RelayStore({ baseDir });
    const queued = await store.askHumanAsync({
      sender: 'agent-1',
      question: 'Proceed with schema drop?'
    });

    const web = await startRelayWebServer({ store, port: 0 });
    runningServers.push(web);

    // Untrusted Host (DNS rebinding defense)
    const badHost = await rawHttpRequest({
      port: web.port,
      headers: { Host: `attacker.example:${web.port}` }
    });
    assert.equal(badHost.statusCode, 403);

    // Port mismatch in Host
    const wrongPortHost = await rawHttpRequest({
      port: web.port,
      headers: { Host: '127.0.0.1:65000' }
    });
    assert.equal(wrongPortHost.statusCode, 403);

    // Allowed loopback Host variants succeed
    for (const allowedHost of [`127.0.0.1:${web.port}`, `localhost:${web.port}`, `[::1]:${web.port}`]) {
      const okRes = await rawHttpRequest({
        port: web.port,
        headers: { Host: allowedHost }
      });
      assert.equal(okRes.statusCode, 200, `Expected 200 for Host ${allowedHost}`);
    }

    // Foreign Origin on POST /reply blocked with 403
    const formPayload = new URLSearchParams({
      questionId: queued.questionId,
      answer: 'forged-answer'
    }).toString();

    const badOriginPost = await rawHttpRequest({
      port: web.port,
      method: 'POST',
      path: '/reply',
      headers: {
        Host: `127.0.0.1:${web.port}`,
        Origin: 'https://evil.example',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(formPayload))
      },
      body: formPayload
    });
    assert.equal(badOriginPost.statusCode, 403);

    // Null Origin blocked with 403
    const nullOriginPost = await rawHttpRequest({
      port: web.port,
      method: 'POST',
      path: '/reply',
      headers: {
        Host: `127.0.0.1:${web.port}`,
        Origin: 'null',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(formPayload))
      },
      body: formPayload
    });
    assert.equal(nullOriginPost.statusCode, 403);

    // Foreign Referer blocked with 403
    const badRefererPost = await rawHttpRequest({
      port: web.port,
      method: 'POST',
      path: '/reply',
      headers: {
        Host: `127.0.0.1:${web.port}`,
        Referer: 'https://evil.example/csrf.html',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(formPayload))
      },
      body: formPayload
    });
    assert.equal(badRefererPost.statusCode, 403);

    // Verify question was never mutated by blocked requests
    const stillPending = await store.checkHumanReply({ questionId: queued.questionId });
    assert.equal(stillPending.status, 'pending');
    assert.equal(stillPending.answer, null);
  });

  it('accepts valid local POST /reply form submissions and JSON requests', async () => {
    const baseDir = await makeTempDir('agent-relay-web-reply-');
    const store = new RelayStore({ baseDir });

    const q1 = await store.askHumanAsync({
      sender: 'agent-ui',
      question: 'Use dark theme palette?'
    });
    const q2 = await store.askHumanAsync({
      sender: 'agent-api',
      question: 'Target Node 20 LTS?'
    });

    const web = await startRelayWebServer({ store, port: 0 });
    runningServers.push(web);

    const formBody = new URLSearchParams({
      questionId: q1.questionId,
      answer: 'Yes, ship neutral slate palette.'
    }).toString();

    const formRes = await rawHttpRequest({
      port: web.port,
      method: 'POST',
      path: '/reply',
      headers: {
        Host: `127.0.0.1:${web.port}`,
        Origin: `http://127.0.0.1:${web.port}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(formBody))
      },
      body: formBody
    });

    assert.equal(formRes.statusCode, 303);
    assert.equal(formRes.headers.location, `/?replied=${encodeURIComponent(q1.questionId)}`);

    const verifyQ1 = await store.checkHumanReply({ questionId: q1.questionId });
    assert.equal(verifyQ1.status, 'answered');
    assert.equal(verifyQ1.answer, 'Yes, ship neutral slate palette.');

    const jsonBody = JSON.stringify({
      questionId: q2.questionId,
      answer: 'Confirmed: test on Node 20 and Node 22.'
    });

    const jsonRes = await rawHttpRequest({
      port: web.port,
      method: 'POST',
      path: '/reply',
      headers: {
        Host: `localhost:${web.port}`,
        Origin: `http://localhost:${web.port}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': String(Buffer.byteLength(jsonBody))
      },
      body: jsonBody
    });

    assert.equal(jsonRes.statusCode, 200);
    const parsed = JSON.parse(jsonRes.body) as { ok: boolean; question: { status: string; answer: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.question.status, 'answered');
    assert.equal(parsed.question.answer, 'Confirmed: test on Node 20 and Node 22.');
  });

  it('flushes a clean HTTP 413 response on oversized POST /reply payloads without ECONNRESET', async () => {
    const baseDir = await makeTempDir('agent-relay-web-413-');
    const store = new RelayStore({ baseDir });
    const q = await store.askHumanAsync({
      sender: 'agent-large',
      question: 'Upload summary?'
    });

    const web = await startRelayWebServer({ store, port: 0 });
    runningServers.push(web);

    const oversizedForm = `questionId=${encodeURIComponent(q.questionId)}&answer=${'A'.repeat(80 * 1024)}`;
    const form413 = await rawHttpRequest({
      port: web.port,
      method: 'POST',
      path: '/reply',
      headers: {
        Host: `127.0.0.1:${web.port}`,
        Origin: `http://127.0.0.1:${web.port}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(oversizedForm))
      },
      body: oversizedForm
    });
    assert.equal(form413.statusCode, 413);
    assert.match(form413.body, /413/);

    const oversizedJson = JSON.stringify({
      questionId: q.questionId,
      answer: 'B'.repeat(80 * 1024)
    });
    const json413 = await rawHttpRequest({
      port: web.port,
      method: 'POST',
      path: '/reply',
      headers: {
        Host: `127.0.0.1:${web.port}`,
        Origin: `http://127.0.0.1:${web.port}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': String(Buffer.byteLength(oversizedJson))
      },
      body: oversizedJson
    });
    assert.equal(json413.statusCode, 413);

    const stillPending = await store.checkHumanReply({ questionId: q.questionId });
    assert.equal(stillPending.status, 'pending');
  });
});
