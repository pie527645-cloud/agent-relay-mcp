import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NotFoundError, RelayStore, ValidationError } from '../store/relayStore.js';
import type { ChannelSummary, FileLease, HumanQuestion, RelayMessage } from '../types.js';
import { escapeHtml } from './escapeHtml.js';

export const DEFAULT_WEB_PORT = 4317;
const MAX_BODY_BYTES = 64 * 1024;
const HARD_DRAIN_CAP_BYTES = 8 * 1024 * 1024;

export interface StartWebServerOptions {
  store: RelayStore;
  port?: number;
}

export interface RunningWebServer {
  server: http.Server;
  host: '127.0.0.1';
  port: number;
  url: string;
  close: () => Promise<void>;
}

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function validateLocalRequestHeaders(
  req: http.IncomingMessage,
  boundPort: number
): { ok: true } | { ok: false; reason: string } {
  const allowedHosts = new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`
  ]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
    `http://[::1]:${boundPort}`
  ]);

  const rawHost = req.headers.host;
  if (typeof rawHost !== 'string' || !allowedHosts.has(rawHost.trim().toLowerCase())) {
    return { ok: false, reason: 'Forbidden: untrusted or missing Host header.' };
  }

  const rawOrigin = req.headers.origin;
  if (rawOrigin !== undefined) {
    if (typeof rawOrigin !== 'string' || !allowedOrigins.has(rawOrigin.trim().toLowerCase())) {
      return { ok: false, reason: 'Forbidden: untrusted Origin header.' };
    }
  }

  const rawReferer = req.headers.referer;
  if (rawReferer !== undefined) {
    if (typeof rawReferer !== 'string') {
      return { ok: false, reason: 'Forbidden: invalid Referer header.' };
    }
    try {
      const parsedReferer = new URL(rawReferer);
      if (!allowedOrigins.has(parsedReferer.origin.toLowerCase())) {
        return { ok: false, reason: 'Forbidden: untrusted Referer origin.' };
      }
    } catch {
      return { ok: false, reason: 'Forbidden: malformed Referer header.' };
    }
  }

  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite !== undefined) {
    if (
      typeof secFetchSite !== 'string' ||
      (secFetchSite !== 'same-origin' && secFetchSite !== 'none')
    ) {
      return { ok: false, reason: 'Forbidden: cross-site request blocked.' };
    }
  }

  return { ok: true };
}

function createPayloadTooLargeError(): Error & { statusCode: number } {
  const err = new Error('Request payload exceeds maximum allowed size.') as Error & {
    statusCode: number;
  };
  err.statusCode = 413;
  return err;
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let exceeded = false;

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      exceeded = true;
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        if (total > HARD_DRAIN_CAP_BYTES) {
          settled = true;
          req.pause();
          reject(createPayloadTooLargeError());
        }
        return;
      }
      if (!exceeded) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      if (exceeded) {
        reject(createPayloadTooLargeError());
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

function sendHtml(
  res: http.ServerResponse,
  statusCode: number,
  html: string,
  extraHeaders?: Record<string, string>
): void {
  setSecurityHeaders(res);
  const headers: Record<string, string | number> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html, 'utf8'),
    ...extraHeaders
  };
  res.writeHead(statusCode, headers);
  res.end(html);
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders?: Record<string, string>
): void {
  setSecurityHeaders(res);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized, 'utf8'),
    ...extraHeaders
  };
  res.writeHead(statusCode, headers);
  res.end(serialized);
}

interface DashboardModel {
  baseDir: string;
  repliedId: string | null;
  channels: Array<{ summary: ChannelSummary; recent: RelayMessage[] }>;
  leases: FileLease[];
  pendingQuestions: HumanQuestion[];
  answeredQuestions: HumanQuestion[];
}

function renderDashboardHtml(model: DashboardModel): string {
  const bannerHtml = model.repliedId
    ? `<div class="banner">Saved reply for question <code>${escapeHtml(model.repliedId)}</code>.</div>`
    : '';

  const pendingHtml =
    model.pendingQuestions.length === 0
      ? '<p class="muted">No pending human questions.</p>'
      : model.pendingQuestions
          .map((q) => {
            const optionsHtml =
              q.options.length > 0
                ? `<div class="options">Suggested choices: ${q.options
                    .map((opt) => `<span class="chip">${escapeHtml(opt)}</span>`)
                    .join(' ')}</div>`
                : '';

            return `<article class="card">
  <div class="meta">
    <strong>${escapeHtml(q.questionId)}</strong>
    <span class="badge priority-${escapeHtml(q.priority)}">${escapeHtml(q.priority)}</span>
    <span>from <code>${escapeHtml(q.sender)}</code></span>
    <span>at ${escapeHtml(q.createdAt)}</span>
  </div>
  <pre class="question-body">${escapeHtml(q.question)}</pre>
  ${optionsHtml}
  <form method="POST" action="/reply" class="reply-form">
    <input type="hidden" name="questionId" value="${escapeHtml(q.questionId)}" />
    <label for="answer-${escapeHtml(q.questionId)}">Reply</label>
    <textarea id="answer-${escapeHtml(q.questionId)}" name="answer" rows="3" required maxlength="16384" placeholder="Enter response for ${escapeHtml(q.sender)}"></textarea>
    <button type="submit">Send Reply</button>
  </form>
</article>`;
          })
          .join('\n');

  const leasesHtml =
    model.leases.length === 0
      ? '<p class="muted">No active file leases.</p>'
      : `<table>
  <thead>
    <tr>
      <th>Path</th>
      <th>Owner</th>
      <th>TTL (s)</th>
      <th>Expires At</th>
    </tr>
  </thead>
  <tbody>
    ${model.leases
      .map(
        (lease) => `<tr>
      <td><code>${escapeHtml(lease.path)}</code></td>
      <td><code>${escapeHtml(lease.owner)}</code></td>
      <td>${escapeHtml(String(lease.ttlSeconds))}</td>
      <td>${escapeHtml(lease.expiresAt)}</td>
    </tr>`
      )
      .join('\n')}
  </tbody>
</table>`;

  const channelsHtml =
    model.channels.length === 0
      ? '<p class="muted">No channels created yet.</p>'
      : model.channels
          .map(({ summary, recent }) => {
            const messagesList =
              recent.length === 0
                ? '<p class="muted">No messages.</p>'
                : `<ul class="msg-list">
        ${recent
          .map((m) => {
            const tagsPart =
              m.tags.length > 0
                ? ` <span class="tags">[${m.tags.map((t) => escapeHtml(t)).join(', ')}]</span>`
                : '';
            return `<li><code>#${escapeHtml(String(m.seq))}</code> <strong>${escapeHtml(m.sender)}</strong> <span class="ts">${escapeHtml(m.createdAt)}</span>${tagsPart}<div class="msg-body">${escapeHtml(m.body)}</div></li>`;
          })
          .join('\n')}
      </ul>`;
            return `<section class="card">
  <h3>Channel <code>${escapeHtml(summary.channel)}</code> <span class="muted">(headSeq: ${escapeHtml(String(summary.headSeq))}, total: ${escapeHtml(String(summary.messageCount))})</span></h3>
  ${messagesList}
</section>`;
          })
          .join('\n');

  const answeredHtml =
    model.answeredQuestions.length === 0
      ? '<p class="muted">No answered questions yet.</p>'
      : model.answeredQuestions
          .slice(-10)
          .reverse()
          .map(
            (q) => `<article class="card muted-card">
  <div class="meta">
    <strong>${escapeHtml(q.questionId)}</strong>
    <span>from <code>${escapeHtml(q.sender)}</code></span>
    <span>answered at ${escapeHtml(q.answeredAt ?? '')}</span>
  </div>
  <div class="q-summary"><strong>Q:</strong> ${escapeHtml(q.question)}</div>
  <div class="a-summary"><strong>A:</strong> ${escapeHtml(q.answer ?? '')}</div>
</article>`
          )
          .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Relay Local Dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { max-width: 980px; margin: 0 auto; padding: 24px 16px; line-height: 1.45; }
    header { border-bottom: 1px solid #8884; padding-bottom: 12px; margin-bottom: 20px; }
    h1 { margin: 0 0 6px 0; font-size: 1.5rem; }
    h2 { margin-top: 28px; font-size: 1.2rem; border-bottom: 1px solid #8883; padding-bottom: 6px; }
    h3 { margin: 0 0 10px 0; font-size: 1.05rem; }
    .muted { opacity: 0.72; font-size: 0.92rem; }
    .banner { padding: 10px 14px; border-radius: 6px; background: #1f7a3f22; border: 1px solid #1f7a3f88; margin-bottom: 16px; }
    .card { border: 1px solid #8884; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
    .muted-card { opacity: 0.88; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 0.9rem; margin-bottom: 8px; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; border: 1px solid #8886; }
    .priority-high, .priority-urgent { border-color: #c93b3b; color: #c93b3b; }
    .question-body, .msg-body { white-space: pre-wrap; word-break: break-word; margin: 8px 0; font-family: inherit; }
    .options { margin: 8px 0; font-size: 0.9rem; }
    .chip { display: inline-block; padding: 2px 8px; border: 1px solid #8885; border-radius: 4px; margin-right: 4px; }
    .reply-form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    textarea { width: 100%; box-sizing: border-box; padding: 8px; font-family: inherit; border-radius: 6px; border: 1px solid #8886; }
    button { align-self: flex-start; padding: 7px 16px; border-radius: 6px; border: 1px solid #8888; cursor: pointer; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #8883; font-size: 0.92rem; }
    .msg-list { list-style: none; padding: 0; margin: 0; }
    .msg-list li { padding: 8px 0; border-top: 1px solid #8882; }
    .ts, .tags { font-size: 0.85rem; opacity: 0.75; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.9em; }
  </style>
</head>
<body>
  <header>
    <h1>Agent Relay Local Dashboard</h1>
    <div class="muted">Store directory: <code>${escapeHtml(model.baseDir)}</code> (bound to <code>127.0.0.1</code> only)</div>
  </header>
  ${bannerHtml}
  <section>
    <h2>Pending Human Questions (${escapeHtml(String(model.pendingQuestions.length))})</h2>
    ${pendingHtml}
  </section>
  <section>
    <h2>Active Cooperative File Leases (${escapeHtml(String(model.leases.length))})</h2>
    ${leasesHtml}
  </section>
  <section>
    <h2>Coordination Channels (${escapeHtml(String(model.channels.length))})</h2>
    ${channelsHtml}
  </section>
  <section>
    <h2>Recent Answered Questions</h2>
    ${answeredHtml}
  </section>
</body>
</html>
`;
}

export async function startRelayWebServer(
  options: StartWebServerOptions
): Promise<RunningWebServer> {
  const { store } = options;
  const requestedPort = options.port ?? DEFAULT_WEB_PORT;

  if (
    !Number.isInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65535
  ) {
    throw new ValidationError('Port must be an integer between 0 and 65535.');
  }

  let boundPort = requestedPort;

  const server = http.createServer(async (req, res) => {
    try {
      const headerCheck = validateLocalRequestHeaders(req, boundPort);
      if (!headerCheck.ok) {
        sendHtml(
          res,
          403,
          `<!DOCTYPE html><html lang="en"><body><h1>403 Forbidden</h1><p>${escapeHtml(headerCheck.reason)}</p></body></html>`
        );
        return;
      }

      const method = req.method ?? 'GET';
      const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      const pathname = parsedUrl.pathname;

      if (method === 'GET' && pathname === '/') {
        const [channelSummaries, leases, allQuestions] = await Promise.all([
          store.listChannels(),
          store.listActiveLeases(),
          store.listQuestions({ includeAnswered: true })
        ]);

        const channelsWithRecent = await Promise.all(
          channelSummaries.map(async (summary) => {
            const tail = await store.tailMessages({ channel: summary.channel, limit: 10 });
            return { summary, recent: tail.messages };
          })
        );

        const pendingQuestions = allQuestions.filter((q) => q.status === 'pending');
        const answeredQuestions = allQuestions.filter((q) => q.status === 'answered');
        const repliedId = parsedUrl.searchParams.get('replied');

        const html = renderDashboardHtml({
          baseDir: store.baseDir,
          repliedId,
          channels: channelsWithRecent,
          leases,
          pendingQuestions,
          answeredQuestions
        });
        sendHtml(res, 200, html);
        return;
      }

      if (method === 'GET' && pathname === '/api/state') {
        const [channels, leases, questions] = await Promise.all([
          store.listChannels(),
          store.listActiveLeases(),
          store.listQuestions({ includeAnswered: true })
        ]);
        sendJson(res, 200, {
          baseDir: store.baseDir,
          channels,
          leases,
          questions
        });
        return;
      }

      if (method === 'POST' && pathname === '/reply') {
        const rawBody = await readRequestBody(req, MAX_BODY_BYTES);
        const contentType = (req.headers['content-type'] ?? '').toLowerCase();
        const wantsJson =
          contentType.includes('application/json') ||
          (req.headers.accept ?? '').toLowerCase().includes('application/json');

        let questionId = '';
        let answer = '';

        if (contentType.includes('application/json')) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawBody);
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON request body.' });
            return;
          }
          if (parsedJson && typeof parsedJson === 'object') {
            const obj = parsedJson as Record<string, unknown>;
            questionId = typeof obj.questionId === 'string' ? obj.questionId : '';
            answer = typeof obj.answer === 'string' ? obj.answer : '';
          }
        } else {
          const params = new URLSearchParams(rawBody);
          questionId = params.get('questionId') ?? '';
          answer = params.get('answer') ?? '';
        }

        try {
          const updated = await store.answerHumanQuestion({ questionId, answer });
          if (wantsJson) {
            sendJson(res, 200, { ok: true, question: updated });
          } else {
            setSecurityHeaders(res);
            res.statusCode = 303;
            res.setHeader('Location', `/?replied=${encodeURIComponent(updated.questionId)}`);
            res.end();
          }
        } catch (err) {
          const status =
            err instanceof ValidationError ? 400 : err instanceof NotFoundError ? 404 : 500;
          const message = err instanceof Error ? err.message : 'Unexpected error.';
          if (wantsJson) {
            sendJson(res, status, { error: message });
          } else {
            sendHtml(
              res,
              status,
              `<!DOCTYPE html><html lang="en"><body><h1>Error ${status}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to dashboard</a></p></body></html>`
            );
          }
        }
        return;
      }

      if (pathname === '/' || pathname === '/api/state' || pathname === '/reply') {
        sendHtml(
          res,
          405,
          '<!DOCTYPE html><html lang="en"><body><h1>405 Method Not Allowed</h1></body></html>'
        );
        return;
      }

      sendHtml(
        res,
        404,
        '<!DOCTYPE html><html lang="en"><body><h1>404 Not Found</h1></body></html>'
      );
    } catch (err) {
      const statusCode =
        err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
          ? err.statusCode
          : 500;
      const message = err instanceof Error ? err.message : 'Internal server error.';
      const extraHeaders = statusCode === 413 ? { Connection: 'close' } : undefined;
      const wantsJson =
        (req.headers['content-type'] ?? '').toLowerCase().includes('application/json') ||
        (req.headers.accept ?? '').toLowerCase().includes('application/json');

      if (wantsJson) {
        sendJson(res, statusCode, { error: message }, extraHeaders);
      } else {
        sendHtml(
          res,
          statusCode,
          `<!DOCTYPE html><html lang="en"><body><h1>Error ${statusCode}</h1><p>${escapeHtml(message)}</p></body></html>`,
          extraHeaders
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, '127.0.0.1');
  });

  const addr = server.address() as AddressInfo;
  boundPort = addr.port;

  return {
    server,
    host: '127.0.0.1',
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      })
  };
}
