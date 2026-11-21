export type QuestionPriority = 'low' | 'normal' | 'high' | 'urgent';

export type QuestionStatus = 'pending' | 'answered';

export interface RelayMessage {
  seq: number;
  channel: string;
  sender: string;
  body: string;
  tags: string[];
  createdAt: string;
}

export interface ChannelLogFile {
  channel: string;
  headSeq: number;
  messages: RelayMessage[];
}

export interface PostMessageInput {
  channel: string;
  sender: string;
  body: string;
  tags?: string[];
}

export interface PostMessageResult {
  message: RelayMessage;
  headSeq: number;
}

export interface ReadMessagesInput {
  channel: string;
  sinceSeq?: number;
  limit?: number;
}

export interface ReadMessagesResult {
  channel: string;
  sinceSeq: number;
  headSeq: number;
  count: number;
  hasMore: boolean;
  messages: RelayMessage[];
}

export interface ChannelSummary {
  channel: string;
  headSeq: number;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface FileLease {
  path: string;
  owner: string;
  ttlSeconds: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface LeasesFile {
  leases: Record<string, FileLease>;
}

export interface AcquireFileLeaseInput {
  path: string;
  owner: string;
  ttlSeconds?: number;
}

export interface AcquireFileLeaseResult {
  acquired: boolean;
  renewed: boolean;
  path: string;
  holder: string;
  acquiredAt?: string;
  expiresAt: string;
  ttlSeconds?: number;
}

export interface ReleaseFileLeaseInput {
  path: string;
  owner: string;
}

export interface ReleaseFileLeaseResult {
  released: boolean;
  alreadyExpiredOrMissing: boolean;
  path: string;
  holder?: string;
  expiresAt?: string;
  reason?: string;
}

export interface HumanQuestion {
  questionId: string;
  sender: string;
  question: string;
  options: string[];
  priority: QuestionPriority;
  status: QuestionStatus;
  createdAt: string;
  answer: string | null;
  answeredAt: string | null;
}

export interface InboxFile {
  questions: HumanQuestion[];
}

export interface AskHumanAsyncInput {
  sender: string;
  question: string;
  options?: string[];
  priority?: QuestionPriority;
}

export interface CheckHumanReplyInput {
  questionId: string;
}

export interface AnswerHumanQuestionInput {
  questionId: string;
  answer: string;
}

export interface RelayStoreOptions {
  baseDir?: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  caseInsensitivePaths?: boolean;
  now?: () => number;
}
