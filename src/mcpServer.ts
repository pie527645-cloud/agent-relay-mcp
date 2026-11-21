import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RelayStore } from './store/relayStore.js';
import {
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_READ_LIMIT,
  MAX_LEASE_TTL_SECONDS,
  MAX_READ_LIMIT
} from './store/sanitize.js';

export const SERVER_NAME = 'agent-relay-mcp';
export const SERVER_VERSION = '0.1.0';

function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function errorResult(err: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message }, null, 2)
      }
    ]
  };
}

export function createRelayMcpServer(store: RelayStore): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  server.registerTool(
    'post_message',
    {
      title: 'Post Channel Message',
      description:
        'Append a timestamped message with a monotonic sequence number to a local coordination channel.',
      inputSchema: z.strictObject({
        channel: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe(
            'Channel identifier using letters, digits, underscores, or hyphens (1 to 64 characters).'
          ),
        sender: z
          .string()
          .min(1)
          .max(128)
          .describe('Identifier of the agent or session posting the message (1 to 128 characters).'),
        body: z
          .string()
          .min(1)
          .max(32768)
          .describe('Plain-text message content to append to the channel log (1 to 32768 characters).'),
        tags: z
          .array(z.string().min(1).max(64))
          .max(16)
          .optional()
          .describe('Optional list of short classification tags attached to the message (up to 16 tags).')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const result = await store.postMessage({
          channel: args.channel,
          sender: args.sender,
          body: args.body,
          tags: args.tags
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'read_messages',
    {
      title: 'Read Channel Messages',
      description:
        'Read channel messages after a sequence cursor along with the latest channel head sequence number.',
      inputSchema: z.strictObject({
        channel: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe(
            'Channel identifier using letters, digits, underscores, or hyphens (1 to 64 characters).'
          ),
        sinceSeq: z
          .number()
          .int()
          .min(0)
          .max(1_000_000_000)
          .optional()
          .describe(
            'Return messages with sequence numbers strictly greater than this value (default 0).'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_READ_LIMIT)
          .optional()
          .describe(
            `Maximum number of messages to return in ascending sequence order (1 to ${MAX_READ_LIMIT}, default ${DEFAULT_READ_LIMIT}).`
          )
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const result = await store.readMessages({
          channel: args.channel,
          sinceSeq: args.sinceSeq,
          limit: args.limit
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'acquire_file_lease',
    {
      title: 'Acquire Cooperative File Lease',
      description:
        'Claim or renew a cooperative exclusive time-bounded lease on a workspace file path.',
      inputSchema: z.strictObject({
        path: z
          .string()
          .min(1)
          .max(512)
          .describe(
            'Relative or workspace-scoped file path to lease without parent directory traversal segments.'
          ),
        owner: z
          .string()
          .min(1)
          .max(128)
          .describe('Identifier of the agent or session requesting the file lease (1 to 128 characters).'),
        ttlSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_LEASE_TTL_SECONDS)
          .optional()
          .describe(
            `Lease time-to-live duration in seconds before automatic expiration (1 to ${MAX_LEASE_TTL_SECONDS}, default ${DEFAULT_LEASE_TTL_SECONDS}).`
          )
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const result = await store.acquireFileLease({
          path: args.path,
          owner: args.owner,
          ttlSeconds: args.ttlSeconds
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'release_file_lease',
    {
      title: 'Release Cooperative File Lease',
      description: 'Release an active cooperative file lease held by the specified owner.',
      inputSchema: z.strictObject({
        path: z
          .string()
          .min(1)
          .max(512)
          .describe('Workspace file path whose lease is being released.'),
        owner: z
          .string()
          .min(1)
          .max(128)
          .describe('Identifier of the agent or session releasing the file lease (1 to 128 characters).')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const result = await store.releaseFileLease({
          path: args.path,
          owner: args.owner
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'ask_human_async',
    {
      title: 'Enqueue Non-Blocking Human Question',
      description:
        'Enqueue a non-blocking question in the local human inbox and return its tracking identifier immediately.',
      inputSchema: z.strictObject({
        sender: z
          .string()
          .min(1)
          .max(128)
          .describe('Identifier of the agent or session asking the question (1 to 128 characters).'),
        question: z
          .string()
          .min(1)
          .max(8192)
          .describe('Question text shown to the human operator in the inbox (1 to 8192 characters).'),
        options: z
          .array(z.string().min(1).max(256))
          .max(20)
          .optional()
          .describe('Optional list of suggested answer choices for the human operator (up to 20 choices).'),
        priority: z
          .enum(['low', 'normal', 'high', 'urgent'])
          .optional()
          .describe('Question urgency level in the human inbox (low, normal, high, or urgent; default normal).')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const record = await store.askHumanAsync({
          sender: args.sender,
          question: args.question,
          options: args.options,
          priority: args.priority
        });
        return jsonResult({
          questionId: record.questionId,
          status: record.status,
          priority: record.priority,
          createdAt: record.createdAt
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'check_human_reply',
    {
      title: 'Check Human Question Reply',
      description: 'Check whether a queued human inbox question is still pending or has been answered.',
      inputSchema: z.strictObject({
        questionId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe('Tracking identifier returned when the question was queued.')
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const record = await store.checkHumanReply({
          questionId: args.questionId
        });
        return jsonResult({
          questionId: record.questionId,
          status: record.status,
          sender: record.sender,
          question: record.question,
          options: record.options,
          priority: record.priority,
          createdAt: record.createdAt,
          answer: record.answer,
          answeredAt: record.answeredAt
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}
