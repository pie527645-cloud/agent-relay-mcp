import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

function runCliSubprocess(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliPath = path.resolve('dist/cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function parseFirstTextJson<T>(result: unknown): T {
  const obj = result as { content?: Array<{ type: string; text?: string }> };
  const firstText = obj.content?.[0]?.text;
  assert.ok(firstText, 'Expected text content in MCP tool result');
  return JSON.parse(firstText) as T;
}

describe('live stdio MCP server and CLI integration', () => {
  it('completes stdio MCP handshake, exposes 6 clean tools, and interoperates with CLI commands', async () => {
    const baseDir = await makeTempDir('agent-relay-mcp-e2e-');
    const mcpEntry = path.resolve('dist/mcp.js');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry, '--dir', baseDir]
    });

    const client = new Client({
      name: 'integration-test-client',
      version: '1.0.0'
    });

    await client.connect(transport);

    try {
      const toolList = await client.listTools();
      const toolNames = toolList.tools.map((t) => t.name);
      assert.deepEqual(toolNames, [
        'post_message',
        'read_messages',
        'acquire_file_lease',
        'release_file_lease',
        'ask_human_async',
        'check_human_reply'
      ]);

      for (const tool of toolList.tools) {
        assert.ok(tool.description && tool.description.length >= 30);
        assert.equal(tool.description.includes('<'), false, `Angle bracket in ${tool.name}`);
        assert.equal(tool.description.includes('>'), false, `Angle bracket in ${tool.name}`);
        assert.equal(
          (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties,
          false,
          `Expected additionalProperties: false on ${tool.name}`
        );
      }

      // 1 & 2: post_message + read_messages
      const post1 = parseFirstTextJson<{ headSeq: number; message: { seq: number } }>(
        await client.callTool({
          name: 'post_message',
          arguments: {
            channel: 'coord',
            sender: 'claude-code',
            body: 'Editing auth middleware next.',
            tags: ['plan']
          }
        })
      );
      assert.equal(post1.headSeq, 1);

      const read1 = parseFirstTextJson<{ headSeq: number; count: number; messages: Array<{ body: string }> }>(
        await client.callTool({
          name: 'read_messages',
          arguments: {
            channel: 'coord',
            sinceSeq: 0,
            limit: 10
          }
        })
      );
      assert.equal(read1.headSeq, 1);
      assert.equal(read1.count, 1);
      assert.equal(read1.messages[0]?.body, 'Editing auth middleware next.');

      // 3 & 4: acquire_file_lease + conflict + traversal rejection + CLI release
      const leaseA = parseFirstTextJson<{ acquired: boolean; holder: string }>(
        await client.callTool({
          name: 'acquire_file_lease',
          arguments: {
            path: 'src/auth/middleware.ts',
            owner: 'claude-code',
            ttlSeconds: 180
          }
        })
      );
      assert.equal(leaseA.acquired, true);

      const leaseConflict = parseFirstTextJson<{ acquired: boolean; holder: string }>(
        await client.callTool({
          name: 'acquire_file_lease',
          arguments: {
            path: 'src/auth/middleware.ts',
            owner: 'cursor-agent',
            ttlSeconds: 120
          }
        })
      );
      assert.equal(leaseConflict.acquired, false);
      assert.equal(leaseConflict.holder, 'claude-code');

      const traversalAttempt = await client.callTool({
        name: 'acquire_file_lease',
        arguments: {
          path: '../outside-repo.ts',
          owner: 'claude-code'
        }
      });
      assert.equal((traversalAttempt as { isError?: boolean }).isError, true);

      // 5 & 6: ask_human_async -> CLI inbox -> CLI reply -> check_human_reply
      const asked = parseFirstTextJson<{ questionId: string; status: string }>(
        await client.callTool({
          name: 'ask_human_async',
          arguments: {
            sender: 'claude-code',
            question: 'Should session tokens rotate on privilege elevation?',
            options: ['rotate-immediately', 'keep-existing'],
            priority: 'high'
          }
        })
      );
      assert.equal(asked.status, 'pending');

      const cliHelp = await runCliSubprocess(['--help']);
      assert.equal(cliHelp.code, 0);
      assert.match(cliHelp.stdout, /agent-relay v0\.1\.0/);

      const cliInbox = await runCliSubprocess(['inbox', '--dir', baseDir, '--json']);
      assert.equal(cliInbox.code, 0);
      const inboxData = JSON.parse(cliInbox.stdout) as {
        questions: Array<{ questionId: string }>;
        leases: Array<{ path: string }>;
      };
      assert.equal(inboxData.questions.length, 1);
      assert.equal(inboxData.questions[0]?.questionId, asked.questionId);
      assert.equal(inboxData.leases.length, 1);
      assert.equal(inboxData.leases[0]?.path, 'src/auth/middleware.ts');

      const cliReply = await runCliSubprocess([
        'reply',
        asked.questionId,
        'rotate-immediately',
        '--dir',
        baseDir,
        '--json'
      ]);
      assert.equal(cliReply.code, 0);

      const checked = parseFirstTextJson<{ status: string; answer: string | null }>(
        await client.callTool({
          name: 'check_human_reply',
          arguments: { questionId: asked.questionId }
        })
      );
      assert.equal(checked.status, 'answered');
      assert.equal(checked.answer, 'rotate-immediately');

      const cliTail = await runCliSubprocess(['tail', 'coord', '--limit', '5', '--dir', baseDir, '--json']);
      assert.equal(cliTail.code, 0);
      const tailData = JSON.parse(cliTail.stdout) as { headSeq: number; count: number };
      assert.equal(tailData.headSeq, 1);
      assert.equal(tailData.count, 1);

      const cliLeaseRelease = await runCliSubprocess([
        'leases',
        '--release',
        'src/auth/middleware.ts',
        '--owner',
        'claude-code',
        '--dir',
        baseDir,
        '--json'
      ]);
      assert.equal(cliLeaseRelease.code, 0);

      const releaseIdempotent = parseFirstTextJson<{ released: boolean; alreadyExpiredOrMissing: boolean }>(
        await client.callTool({
          name: 'release_file_lease',
          arguments: {
            path: 'src/auth/middleware.ts',
            owner: 'claude-code'
          }
        })
      );
      assert.equal(releaseIdempotent.released, true);
      assert.equal(releaseIdempotent.alreadyExpiredOrMissing, true);
    } finally {
      await client.close();
    }
  });
});
