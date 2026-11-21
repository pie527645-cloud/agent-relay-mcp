import { SERVER_VERSION } from './mcpServer.js';
import { RelayStore, ValidationError } from './store/relayStore.js';
import { resolveRelayDir } from './store/sanitize.js';
import { DEFAULT_WEB_PORT, startRelayWebServer } from './web/server.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text: string) => {
    process.stdout.write(text);
  },
  stderr: (text: string) => {
    process.stderr.write(text);
  }
};

interface ParsedCliArgs {
  command?: string;
  positionals: string[];
  dir?: string;
  json: boolean;
  all: boolean;
  help: boolean;
  version: boolean;
  since?: number;
  limit?: number;
  port?: number;
  releasePath?: string;
  owner?: string;
}

function parseStrictInt(raw: string, flagName: string): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ValidationError(`Invalid integer for ${flagName}: "${raw}".`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationError(`Out-of-range integer for ${flagName}: "${raw}".`);
  }
  return parsed;
}

function takeOptionValue(argv: string[], index: number, flagName: string): [string, number] {
  const current = argv[index] ?? '';
  const eqPrefix = `${flagName}=`;
  if (current.startsWith(eqPrefix)) {
    return [current.slice(eqPrefix.length), index];
  }
  const next = argv[index + 1];
  if (next === undefined) {
    throw new ValidationError(`Missing value for ${flagName}.`);
  }
  return [next, index + 1];
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    positionals: [],
    json: false,
    all: false,
    help: false,
    version: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--all' || arg === '-a') {
      result.all = true;
    } else if (arg === '--dir' || arg.startsWith('--dir=')) {
      const [val, nextIdx] = takeOptionValue(argv, i, '--dir');
      result.dir = val;
      i = nextIdx;
    } else if (arg === '--since' || arg.startsWith('--since=')) {
      const [val, nextIdx] = takeOptionValue(argv, i, '--since');
      result.since = parseStrictInt(val, '--since');
      i = nextIdx;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const [val, nextIdx] = takeOptionValue(argv, i, '--limit');
      result.limit = parseStrictInt(val, '--limit');
      i = nextIdx;
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const [val, nextIdx] = takeOptionValue(argv, i, '--port');
      result.port = parseStrictInt(val, '--port');
      i = nextIdx;
    } else if (arg === '--release' || arg.startsWith('--release=')) {
      const [val, nextIdx] = takeOptionValue(argv, i, '--release');
      result.releasePath = val;
      i = nextIdx;
    } else if (arg === '--owner' || arg.startsWith('--owner=')) {
      const [val, nextIdx] = takeOptionValue(argv, i, '--owner');
      result.owner = val;
      i = nextIdx;
    } else if (arg.startsWith('-')) {
      throw new ValidationError(`Unknown option: ${arg}`);
    } else if (result.command === undefined) {
      result.command = arg;
    } else {
      result.positionals.push(arg);
    }
  }

  return result;
}

export function formatHelpText(): string {
  return [
    `agent-relay v${SERVER_VERSION}`,
    'Local-first cross-session coding agent bridge, cooperative file-lease guard, and human question inbox.',
    '',
    'Usage:',
    '  agent-relay <command> [options]',
    '',
    'Commands:',
    '  inbox [--all]                                Show pending (or all) human questions and active leases',
    '  reply <questionId> "<answer>"                Answer a queued human inbox question',
    '  tail <channel> [--since <seq>] [--limit <n>] Read recent messages from a coordination channel',
    '  leases [--release <path> --owner <name>]     List active file leases or release a held lease',
    `  web [--port ${DEFAULT_WEB_PORT}]                            Start local-only dashboard on 127.0.0.1`,
    '',
    'Global Options:',
    '  --dir <path>    Override state directory (default: ~/.agent-relay or AGENT_RELAY_DIR)',
    '  --json          Format output as machine-readable JSON',
    '  --help, -h      Show help message',
    '  --version, -v   Print CLI version'
  ].join('\n');
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}\n`);
    return 1;
  }

  if (parsed.version) {
    io.stdout(`agent-relay ${SERVER_VERSION}\n`);
    return 0;
  }

  if (parsed.help || !parsed.command) {
    io.stdout(`${formatHelpText()}\n`);
    return parsed.help ? 0 : 1;
  }

  let store: RelayStore;
  try {
    const baseDir = resolveRelayDir(parsed.dir);
    store = new RelayStore({ baseDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      io.stdout(`${JSON.stringify({ error: message }, null, 2)}\n`);
    } else {
      io.stderr(`Error: ${message}\n`);
    }
    return 1;
  }

  try {
    switch (parsed.command) {
      case 'inbox': {
        const [questions, leases] = await Promise.all([
          store.listQuestions({ includeAnswered: parsed.all }),
          store.listActiveLeases()
        ]);
        if (parsed.json) {
          io.stdout(
            `${JSON.stringify(
              {
                baseDir: store.baseDir,
                includeAnswered: parsed.all,
                questions,
                leases
              },
              null,
              2
            )}\n`
          );
          return 0;
        }

        const heading = parsed.all ? 'Human Questions (all)' : 'Pending Human Questions';
        io.stdout(`=== ${heading} (${questions.length}) ===\n`);
        if (questions.length === 0) {
          io.stdout('  (none)\n');
        } else {
          for (const q of questions) {
            io.stdout(
              `  [${q.status.toUpperCase()}] ${q.questionId} (${q.priority}) from ${q.sender} @ ${q.createdAt}\n`
            );
            io.stdout(`    Q: ${q.question}\n`);
            if (q.options.length > 0) {
              io.stdout(`    Options: ${q.options.join(' | ')}\n`);
            }
            if (q.status === 'answered') {
              io.stdout(`    A (${q.answeredAt}): ${q.answer}\n`);
            }
          }
        }

        io.stdout(`\n=== Active File Leases (${leases.length}) ===\n`);
        if (leases.length === 0) {
          io.stdout('  (none)\n');
        } else {
          for (const lease of leases) {
            io.stdout(`  ${lease.path} -> ${lease.owner} (expires ${lease.expiresAt})\n`);
          }
        }
        return 0;
      }

      case 'reply': {
        const questionId = parsed.positionals[0];
        const answer = parsed.positionals.slice(1).join(' ');
        if (!questionId || !answer) {
          throw new ValidationError('Usage: agent-relay reply <questionId> "<answer>"');
        }
        const updated = await store.answerHumanQuestion({ questionId, answer });
        if (parsed.json) {
          io.stdout(`${JSON.stringify({ ok: true, question: updated }, null, 2)}\n`);
        } else {
          io.stdout(
            `Answered question ${updated.questionId} for ${updated.sender} at ${updated.answeredAt}.\n`
          );
        }
        return 0;
      }

      case 'tail': {
        const channel = parsed.positionals[0];
        if (!channel) {
          throw new ValidationError('Usage: agent-relay tail <channel> [--since <seq>] [--limit <n>]');
        }
        const result = await store.tailMessages({
          channel,
          sinceSeq: parsed.since,
          limit: parsed.limit
        });
        if (parsed.json) {
          io.stdout(`${JSON.stringify(result, null, 2)}\n`);
          return 0;
        }
        io.stdout(`Channel "${result.channel}" (headSeq=${result.headSeq}, showing=${result.count})\n`);
        if (result.messages.length === 0) {
          io.stdout('  (no messages)\n');
        } else {
          for (const msg of result.messages) {
            const tagsSuffix = msg.tags.length > 0 ? ` [${msg.tags.join(', ')}]` : '';
            io.stdout(`  #${msg.seq} [${msg.createdAt}] ${msg.sender}${tagsSuffix}: ${msg.body}\n`);
          }
        }
        return 0;
      }

      case 'leases': {
        if (parsed.releasePath !== undefined || parsed.owner !== undefined) {
          if (!parsed.releasePath || !parsed.owner) {
            throw new ValidationError(
              'Releasing a lease requires both --release <path> and --owner <name>.'
            );
          }
          const releaseResult = await store.releaseFileLease({
            path: parsed.releasePath,
            owner: parsed.owner
          });
          if (parsed.json) {
            io.stdout(`${JSON.stringify(releaseResult, null, 2)}\n`);
          } else if (releaseResult.released) {
            io.stdout(`Released lease for ${releaseResult.path}.\n`);
          } else {
            io.stderr(
              `Could not release lease for ${releaseResult.path}: ${releaseResult.reason ?? 'held by another owner'} (holder: ${releaseResult.holder ?? 'unknown'}).\n`
            );
          }
          return releaseResult.released ? 0 : 1;
        }

        const leases = await store.listActiveLeases();
        if (parsed.json) {
          io.stdout(`${JSON.stringify({ leases }, null, 2)}\n`);
          return 0;
        }
        io.stdout(`Active File Leases (${leases.length}):\n`);
        if (leases.length === 0) {
          io.stdout('  (none)\n');
        } else {
          for (const lease of leases) {
            io.stdout(
              `  ${lease.path} -> ${lease.owner} (ttl=${lease.ttlSeconds}s, expires=${lease.expiresAt})\n`
            );
          }
        }
        return 0;
      }

      case 'web': {
        const running = await startRelayWebServer({
          store,
          port: parsed.port ?? DEFAULT_WEB_PORT
        });
        if (parsed.json) {
          io.stdout(
            `${JSON.stringify({ url: running.url, host: running.host, port: running.port, baseDir: store.baseDir })}\n`
          );
        } else {
          io.stdout(
            `Agent Relay local dashboard listening on ${running.url} (store: ${store.baseDir})\n`
          );
        }

        await new Promise<void>((resolve) => {
          const shutdown = () => {
            process.off('SIGINT', shutdown);
            process.off('SIGTERM', shutdown);
            running.close().then(
              () => resolve(),
              () => resolve()
            );
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
        return 0;
      }

      default:
        throw new ValidationError(`Unknown command: "${parsed.command}". Run "agent-relay --help".`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      io.stdout(`${JSON.stringify({ error: message }, null, 2)}\n`);
    } else {
      io.stderr(`Error: ${message}\n`);
    }
    return 1;
  }
}
