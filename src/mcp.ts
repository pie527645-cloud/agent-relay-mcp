#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRelayMcpServer, SERVER_NAME, SERVER_VERSION } from './mcpServer.js';
import { RelayStore } from './store/relayStore.js';
import { resolveRelayDir } from './store/sanitize.js';

function parseMcpArgs(argv: string[]): { dir?: string; help: boolean; version: boolean } {
  let dir: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --dir.');
      }
      dir = next;
      i += 1;
    } else if (arg && arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    }
  }

  return { dir, help, version };
}

async function main(): Promise<void> {
  const parsed = parseMcpArgs(process.argv.slice(2));

  if (parsed.version) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  if (parsed.help) {
    process.stdout.write(
      [
        `${SERVER_NAME} v${SERVER_VERSION}`,
        'Stdio Model Context Protocol server for local-first cross-session agent coordination.',
        '',
        'Usage:',
        '  agent-relay-mcp [--dir <path>]',
        '',
        'Options:',
        '  --dir <path>   Override state directory (default: ~/.agent-relay or AGENT_RELAY_DIR)',
        '  --help, -h     Show this help text',
        '  --version, -v  Print version'
      ].join('\n') + '\n'
    );
    return;
  }

  const baseDir = resolveRelayDir(parsed.dir);
  const store = new RelayStore({ baseDir });
  const server = createRelayMcpServer(store);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error starting ${SERVER_NAME}: ${message}\n`);
  process.exit(1);
});
