import os from 'node:os';
import path from 'node:path';
import type { QuestionPriority } from '../types.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const CHANNEL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const QUESTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:\//;
const VALID_PRIORITIES = new Set<QuestionPriority>(['low', 'normal', 'high', 'urgent']);

export const DEFAULT_LEASE_TTL_SECONDS = 120;
export const MAX_LEASE_TTL_SECONDS = 3600;
export const DEFAULT_READ_LIMIT = 50;
export const MAX_READ_LIMIT = 500;

export function hasControlChars(value: string, allowNewlines = false): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (allowNewlines && (code === 0x09 || code === 0x0a || code === 0x0d)) {
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function resolveRelayDir(cliDir?: string, envDir?: string): string {
  const candidate = cliDir?.trim() || envDir?.trim() || process.env.AGENT_RELAY_DIR?.trim();
  if (candidate && candidate.length > 0) {
    if (hasControlChars(candidate, false)) {
      throw new ValidationError('Relay directory path contains invalid control characters.');
    }
    return path.resolve(candidate);
  }
  return path.join(os.homedir(), '.agent-relay');
}

export function sanitizeChannelName(rawChannel: string): string {
  if (typeof rawChannel !== 'string') {
    throw new ValidationError('Channel name is required.');
  }
  const trimmed = rawChannel.trim();
  if (!CHANNEL_NAME_PATTERN.test(trimmed)) {
    throw new ValidationError(
      'Channel name must be 1 to 64 characters using only letters, digits, underscores, or hyphens.'
    );
  }
  return trimmed;
}

export function sanitizeIdentifier(rawValue: string, label: string, maxLength = 128): string {
  if (typeof rawValue !== 'string') {
    throw new ValidationError(`${label} is required.`);
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new ValidationError(`${label} must be between 1 and ${maxLength} characters.`);
  }
  if (hasControlChars(trimmed, false)) {
    throw new ValidationError(`${label} contains invalid control characters.`);
  }
  return trimmed;
}

export function sanitizeTextContent(rawValue: string, label: string, maxLength: number): string {
  if (typeof rawValue !== 'string') {
    throw new ValidationError(`${label} is required.`);
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new ValidationError(`${label} must be between 1 and ${maxLength} characters.`);
  }
  if (hasControlChars(trimmed, true)) {
    throw new ValidationError(`${label} contains invalid control characters.`);
  }
  return trimmed;
}

export function sanitizeTags(rawTags?: string[]): string[] {
  if (rawTags === undefined) {
    return [];
  }
  if (!Array.isArray(rawTags)) {
    throw new ValidationError('Tags must be an array of strings.');
  }
  if (rawTags.length > 16) {
    throw new ValidationError('A message cannot have more than 16 tags.');
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of rawTags) {
    const tag = sanitizeIdentifier(item, 'Tag', 64);
    if (!seen.has(tag)) {
      seen.add(tag);
      cleaned.push(tag);
    }
  }
  return cleaned;
}

export function sanitizeOptions(rawOptions?: string[]): string[] {
  if (rawOptions === undefined) {
    return [];
  }
  if (!Array.isArray(rawOptions)) {
    throw new ValidationError('Question options must be an array of strings.');
  }
  if (rawOptions.length > 20) {
    throw new ValidationError('A question cannot have more than 20 options.');
  }
  const cleaned: string[] = [];
  for (const item of rawOptions) {
    cleaned.push(sanitizeIdentifier(item, 'Option', 256));
  }
  return cleaned;
}

export function sanitizePriority(rawPriority?: string): QuestionPriority {
  if (rawPriority === undefined) {
    return 'normal';
  }
  const normalized = rawPriority.trim().toLowerCase() as QuestionPriority;
  if (!VALID_PRIORITIES.has(normalized)) {
    throw new ValidationError('Priority must be one of: low, normal, high, urgent.');
  }
  return normalized;
}

export function sanitizeQuestionId(rawQuestionId: string): string {
  if (typeof rawQuestionId !== 'string') {
    throw new ValidationError('Question identifier is required.');
  }
  const trimmed = rawQuestionId.trim();
  if (!QUESTION_ID_PATTERN.test(trimmed)) {
    throw new ValidationError('Question identifier has an invalid format.');
  }
  return trimmed;
}

export function normalizeLeasePath(rawPath: string): string {
  if (typeof rawPath !== 'string') {
    throw new ValidationError('Lease path is required.');
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    throw new ValidationError('Lease path must be between 1 and 512 characters.');
  }
  if (hasControlChars(trimmed, false)) {
    throw new ValidationError('Lease path contains invalid control characters.');
  }

  const unified = trimmed.replaceAll('\\', '/');
  if (unified.startsWith('//')) {
    throw new ValidationError('Network UNC paths are not allowed for file leases.');
  }

  let prefix = '';
  let remainder = unified;

  if (WINDOWS_DRIVE_PREFIX.test(unified)) {
    const driveLetter = unified.charAt(0).toUpperCase();
    prefix = `${driveLetter}:/`;
    remainder = unified.slice(3);
  } else if (unified.startsWith('/')) {
    prefix = '/';
    remainder = unified.slice(1);
  }

  if (remainder.includes(':')) {
    throw new ValidationError('Lease path contains an invalid colon character.');
  }

  const rawSegments = remainder.split('/');
  const cleanSegments: string[] = [];

  for (const segment of rawSegments) {
    if (segment === '..') {
      throw new ValidationError('Lease path cannot contain parent directory traversal ("..").');
    }
    if (segment === '' || segment === '.') {
      continue;
    }
    cleanSegments.push(segment);
  }

  if (cleanSegments.length === 0) {
    throw new ValidationError('Lease path must target a specific file.');
  }

  return `${prefix}${cleanSegments.join('/')}`;
}

export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function toLeaseLookupKey(
  rawOrNormalizedPath: string,
  caseInsensitive: boolean = isCaseInsensitivePlatform()
): string {
  const normalized = normalizeLeasePath(rawOrNormalizedPath);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function validateTtlSeconds(rawTtl?: number): number {
  if (rawTtl === undefined) {
    return DEFAULT_LEASE_TTL_SECONDS;
  }
  if (typeof rawTtl !== 'number' || !Number.isFinite(rawTtl) || !Number.isInteger(rawTtl)) {
    throw new ValidationError('Lease ttlSeconds must be an integer.');
  }
  if (rawTtl < 1 || rawTtl > MAX_LEASE_TTL_SECONDS) {
    throw new ValidationError(
      `Lease ttlSeconds must be between 1 and ${MAX_LEASE_TTL_SECONDS} seconds.`
    );
  }
  return rawTtl;
}

export function validateSinceSeq(rawSince?: number): number {
  if (rawSince === undefined) {
    return 0;
  }
  if (typeof rawSince !== 'number' || !Number.isFinite(rawSince) || !Number.isInteger(rawSince) || rawSince < 0) {
    throw new ValidationError('sinceSeq must be a non-negative integer.');
  }
  return rawSince;
}

export function validateReadLimit(rawLimit?: number): number {
  if (rawLimit === undefined) {
    return DEFAULT_READ_LIMIT;
  }
  if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || !Number.isInteger(rawLimit)) {
    throw new ValidationError('limit must be an integer.');
  }
  if (rawLimit < 1 || rawLimit > MAX_READ_LIMIT) {
    throw new ValidationError(`limit must be between 1 and ${MAX_READ_LIMIT}.`);
  }
  return rawLimit;
}
