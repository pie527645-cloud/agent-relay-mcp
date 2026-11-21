import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AcquireFileLeaseInput,
  AcquireFileLeaseResult,
  AnswerHumanQuestionInput,
  AskHumanAsyncInput,
  ChannelLogFile,
  ChannelSummary,
  CheckHumanReplyInput,
  FileLease,
  HumanQuestion,
  InboxFile,
  LeasesFile,
  PostMessageInput,
  PostMessageResult,
  ReadMessagesInput,
  ReadMessagesResult,
  RelayMessage,
  RelayStoreOptions,
  ReleaseFileLeaseInput,
  ReleaseFileLeaseResult
} from '../types.js';
import { atomicWriteJson, readJsonFile, withFileLock } from './lock.js';
import {
  normalizeLeasePath,
  resolveRelayDir,
  sanitizeChannelName,
  sanitizeIdentifier,
  sanitizeOptions,
  sanitizePriority,
  sanitizeQuestionId,
  sanitizeTags,
  sanitizeTextContent,
  ValidationError,
  validateReadLimit,
  validateSinceSeq,
  validateTtlSeconds
} from './sanitize.js';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class RelayStore {
  public readonly baseDir: string;
  private readonly channelsDir: string;
  private readonly locksDir: string;
  private readonly leasesFilePath: string;
  private readonly inboxFilePath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly now: () => number;

  constructor(options: RelayStoreOptions = {}) {
    this.baseDir = resolveRelayDir(options.baseDir);
    this.channelsDir = path.join(this.baseDir, 'channels');
    this.locksDir = path.join(this.baseDir, 'locks');
    this.leasesFilePath = path.join(this.baseDir, 'leases.json');
    this.inboxFilePath = path.join(this.baseDir, 'inbox.json');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
    this.lockStaleMs = options.lockStaleMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
  }

  private getChannelFilePath(channel: string): string {
    return path.join(this.channelsDir, `${channel}.json`);
  }

  private getLockPath(lockName: string): string {
    return path.join(this.locksDir, `${lockName}.lock`);
  }

  private withLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.getLockPath(lockName), fn, {
      timeoutMs: this.lockTimeoutMs,
      staleMs: this.lockStaleMs
    });
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  public async postMessage(input: PostMessageInput): Promise<PostMessageResult> {
    const channel = sanitizeChannelName(input.channel);
    const sender = sanitizeIdentifier(input.sender, 'Sender', 128);
    const body = sanitizeTextContent(input.body, 'Message body', 32_768);
    const tags = sanitizeTags(input.tags);
    const channelPath = this.getChannelFilePath(channel);

    return this.withLock(`channel-${channel}`, async () => {
      const existing = await readJsonFile<ChannelLogFile>(channelPath);
      const state: ChannelLogFile = existing ?? {
        channel,
        headSeq: 0,
        messages: []
      };

      const nextSeq = state.headSeq + 1;
      const message: RelayMessage = {
        seq: nextSeq,
        channel,
        sender,
        body,
        tags,
        createdAt: this.nowIso()
      };

      state.headSeq = nextSeq;
      state.messages.push(message);

      await atomicWriteJson(channelPath, state);
      return {
        message,
        headSeq: state.headSeq
      };
    });
  }

  public async readMessages(input: ReadMessagesInput): Promise<ReadMessagesResult> {
    const channel = sanitizeChannelName(input.channel);
    const sinceSeq = validateSinceSeq(input.sinceSeq);
    const limit = validateReadLimit(input.limit);
    const channelPath = this.getChannelFilePath(channel);

    const existing = await readJsonFile<ChannelLogFile>(channelPath);
    if (!existing) {
      return {
        channel,
        sinceSeq,
        headSeq: 0,
        count: 0,
        hasMore: false,
        messages: []
      };
    }

    const filtered = existing.messages.filter((msg) => msg.seq > sinceSeq);
    const messages = filtered.slice(0, limit);

    return {
      channel,
      sinceSeq,
      headSeq: existing.headSeq,
      count: messages.length,
      hasMore: filtered.length > limit,
      messages
    };
  }

  public async tailMessages(input: ReadMessagesInput): Promise<ReadMessagesResult> {
    const channel = sanitizeChannelName(input.channel);
    const limit = validateReadLimit(input.limit);
    const channelPath = this.getChannelFilePath(channel);

    if (input.sinceSeq !== undefined) {
      return this.readMessages(input);
    }

    const existing = await readJsonFile<ChannelLogFile>(channelPath);
    if (!existing) {
      return {
        channel,
        sinceSeq: 0,
        headSeq: 0,
        count: 0,
        hasMore: false,
        messages: []
      };
    }

    const messages = existing.messages.slice(-limit);
    const first = messages[0];
    const effectiveSince = first ? first.seq - 1 : existing.headSeq;

    return {
      channel,
      sinceSeq: effectiveSince,
      headSeq: existing.headSeq,
      count: messages.length,
      hasMore: existing.messages.length > limit,
      messages
    };
  }

  public async listChannels(): Promise<ChannelSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.channelsDir);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const summaries: ChannelSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const channelName = entry.slice(0, -5);
      try {
        sanitizeChannelName(channelName);
      } catch {
        continue;
      }
      const data = await readJsonFile<ChannelLogFile>(path.join(this.channelsDir, entry));
      if (!data) {
        continue;
      }
      const lastMsg = data.messages[data.messages.length - 1];
      summaries.push({
        channel: data.channel,
        headSeq: data.headSeq,
        messageCount: data.messages.length,
        lastMessageAt: lastMsg ? lastMsg.createdAt : null
      });
    }

    summaries.sort((a, b) => a.channel.localeCompare(b.channel));
    return summaries;
  }

  private pruneExpiredLeases(leases: Record<string, FileLease>, nowMs: number): boolean {
    let mutated = false;
    for (const [leaseKey, lease] of Object.entries(leases)) {
      const expiresMs = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
        delete leases[leaseKey];
        mutated = true;
      }
    }
    return mutated;
  }

  public async acquireFileLease(input: AcquireFileLeaseInput): Promise<AcquireFileLeaseResult> {
    const normalizedPath = normalizeLeasePath(input.path);
    const owner = sanitizeIdentifier(input.owner, 'Lease owner', 128);
    const ttlSeconds = validateTtlSeconds(input.ttlSeconds);

    return this.withLock('leases', async () => {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const expiresIso = new Date(nowMs + ttlSeconds * 1000).toISOString();

      const existingFile = await readJsonFile<LeasesFile>(this.leasesFilePath);
      const state: LeasesFile = existingFile ?? { leases: {} };
      const pruned = this.pruneExpiredLeases(state.leases, nowMs);

      const current = state.leases[normalizedPath];
      if (current && current.owner !== owner) {
        if (pruned) {
          await atomicWriteJson(this.leasesFilePath, state);
        }
        return {
          acquired: false,
          renewed: false,
          path: normalizedPath,
          holder: current.owner,
          expiresAt: current.expiresAt
        };
      }

      const isRenewal = Boolean(current && current.owner === owner);
      const updatedLease: FileLease = {
        path: normalizedPath,
        owner,
        ttlSeconds,
        acquiredAt: current ? current.acquiredAt : nowIso,
        renewedAt: nowIso,
        expiresAt: expiresIso
      };

      state.leases[normalizedPath] = updatedLease;
      await atomicWriteJson(this.leasesFilePath, state);

      return {
        acquired: true,
        renewed: isRenewal,
        path: normalizedPath,
        holder: owner,
        acquiredAt: updatedLease.acquiredAt,
        expiresAt: updatedLease.expiresAt,
        ttlSeconds
      };
    });
  }

  public async releaseFileLease(input: ReleaseFileLeaseInput): Promise<ReleaseFileLeaseResult> {
    const normalizedPath = normalizeLeasePath(input.path);
    const owner = sanitizeIdentifier(input.owner, 'Lease owner', 128);

    return this.withLock('leases', async () => {
      const nowMs = this.now();
      const existingFile = await readJsonFile<LeasesFile>(this.leasesFilePath);
      const state: LeasesFile = existingFile ?? { leases: {} };

      const beforePrune = state.leases[normalizedPath];
      const pruned = this.pruneExpiredLeases(state.leases, nowMs);
      const active = state.leases[normalizedPath];

      if (!active) {
        if (pruned) {
          await atomicWriteJson(this.leasesFilePath, state);
        }
        return {
          released: true,
          alreadyExpiredOrMissing: true,
          path: normalizedPath,
          reason: beforePrune ? 'Lease had already expired.' : 'No active lease existed for path.'
        };
      }

      if (active.owner !== owner) {
        if (pruned) {
          await atomicWriteJson(this.leasesFilePath, state);
        }
        return {
          released: false,
          alreadyExpiredOrMissing: false,
          path: normalizedPath,
          holder: active.owner,
          expiresAt: active.expiresAt,
          reason: 'Lease is currently held by a different owner.'
        };
      }

      delete state.leases[normalizedPath];
      await atomicWriteJson(this.leasesFilePath, state);

      return {
        released: true,
        alreadyExpiredOrMissing: false,
        path: normalizedPath
      };
    });
  }

  public async listActiveLeases(): Promise<FileLease[]> {
    return this.withLock('leases', async () => {
      const nowMs = this.now();
      const existingFile = await readJsonFile<LeasesFile>(this.leasesFilePath);
      if (!existingFile) {
        return [];
      }
      const pruned = this.pruneExpiredLeases(existingFile.leases, nowMs);
      if (pruned) {
        await atomicWriteJson(this.leasesFilePath, existingFile);
      }
      return Object.values(existingFile.leases).sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  public async askHumanAsync(input: AskHumanAsyncInput): Promise<HumanQuestion> {
    const sender = sanitizeIdentifier(input.sender, 'Sender', 128);
    const question = sanitizeTextContent(input.question, 'Question', 8_192);
    const options = sanitizeOptions(input.options);
    const priority = sanitizePriority(input.priority);

    return this.withLock('inbox', async () => {
      const existingFile = await readJsonFile<InboxFile>(this.inboxFilePath);
      const state: InboxFile = existingFile ?? { questions: [] };

      const timestampPart = this.now().toString(36);
      const randomPart = crypto.randomBytes(4).toString('hex');
      const questionId = `q_${timestampPart}_${randomPart}`;

      const record: HumanQuestion = {
        questionId,
        sender,
        question,
        options,
        priority,
        status: 'pending',
        createdAt: this.nowIso(),
        answer: null,
        answeredAt: null
      };

      state.questions.push(record);
      await atomicWriteJson(this.inboxFilePath, state);

      return record;
    });
  }

  public async checkHumanReply(input: CheckHumanReplyInput): Promise<HumanQuestion> {
    const questionId = sanitizeQuestionId(input.questionId);
    const existingFile = await readJsonFile<InboxFile>(this.inboxFilePath);
    const found = existingFile?.questions.find((q) => q.questionId === questionId);
    if (!found) {
      throw new NotFoundError(`Question not found: ${questionId}`);
    }
    return found;
  }

  public async answerHumanQuestion(input: AnswerHumanQuestionInput): Promise<HumanQuestion> {
    const questionId = sanitizeQuestionId(input.questionId);
    const answer = sanitizeTextContent(input.answer, 'Answer', 16_384);

    return this.withLock('inbox', async () => {
      const existingFile = await readJsonFile<InboxFile>(this.inboxFilePath);
      if (!existingFile) {
        throw new NotFoundError(`Question not found: ${questionId}`);
      }

      const index = existingFile.questions.findIndex((q) => q.questionId === questionId);
      if (index === -1) {
        throw new NotFoundError(`Question not found: ${questionId}`);
      }

      const target = existingFile.questions[index];
      if (!target) {
        throw new NotFoundError(`Question not found: ${questionId}`);
      }

      const updated: HumanQuestion = {
        ...target,
        status: 'answered',
        answer,
        answeredAt: this.nowIso()
      };

      existingFile.questions[index] = updated;
      await atomicWriteJson(this.inboxFilePath, existingFile);

      return updated;
    });
  }

  public async listQuestions(options: { includeAnswered?: boolean } = {}): Promise<HumanQuestion[]> {
    const existingFile = await readJsonFile<InboxFile>(this.inboxFilePath);
    if (!existingFile) {
      return [];
    }
    const includeAnswered = options.includeAnswered ?? false;
    const filtered = includeAnswered
      ? existingFile.questions.slice()
      : existingFile.questions.filter((q) => q.status === 'pending');

    return filtered;
  }
}

export { ValidationError };
