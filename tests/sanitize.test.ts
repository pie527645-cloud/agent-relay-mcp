import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_LEASE_TTL_SECONDS,
  escapeHtml,
  MAX_LEASE_TTL_SECONDS,
  normalizeLeasePath,
  resolveRelayDir,
  sanitizeChannelName,
  toLeaseLookupKey,
  ValidationError
} from '../src/index.js';
import { validateTtlSeconds } from '../src/store/sanitize.js';

describe('sanitize and path normalization', () => {
  it('accepts valid channel names and trims outer whitespace', () => {
    assert.equal(sanitizeChannelName('general'), 'general');
    assert.equal(sanitizeChannelName('  team_alpha-01  '), 'team_alpha-01');
    assert.equal(sanitizeChannelName('A'.repeat(64)), 'A'.repeat(64));
  });

  it('rejects invalid channel names including traversal and special characters', () => {
    const invalidChannels = [
      '',
      '   ',
      'bad/channel',
      'bad\\channel',
      '..',
      'channel.json',
      'space name',
      'bad\x00char',
      'a'.repeat(65)
    ];

    for (const candidate of invalidChannels) {
      assert.throws(() => sanitizeChannelName(candidate), ValidationError);
    }
  });

  it('normalizes clean relative and absolute lease paths uniformly across platforms', () => {
    assert.equal(normalizeLeasePath('src/index.ts'), 'src/index.ts');
    assert.equal(normalizeLeasePath('./src\\store//relayStore.ts'), 'src/store/relayStore.ts');
    assert.equal(normalizeLeasePath('/workspace/project/./app.ts'), '/workspace/project/app.ts');
    assert.equal(normalizeLeasePath('c:\\repo\\src\\main.ts'), 'C:/repo/src/main.ts');
    assert.equal(toLeaseLookupKey('src/FooBar.ts', true), 'src/foobar.ts');
    assert.equal(toLeaseLookupKey('src/FooBar.ts', false), 'src/FooBar.ts');
  });

  it('blocks parent directory traversal, control chars, UNC paths, and invalid colons', () => {
    const forbiddenPaths = [
      '',
      '   ',
      '.',
      './',
      '/',
      'C:/',
      '../secret.env',
      'src/../../etc/passwd',
      'src\\..\\private.key',
      'C:../outside.txt',
      '//server/share/file.txt',
      '\\\\server\\share\\file.txt',
      'src/file.txt:ads',
      'src/null\x00byte.ts',
      'src/newline\ninject.ts'
    ];

    for (const badPath of forbiddenPaths) {
      assert.throws(() => normalizeLeasePath(badPath), ValidationError, `Expected failure for ${badPath}`);
    }
  });

  it('validates lease TTL bounds', () => {
    assert.equal(validateTtlSeconds(undefined), DEFAULT_LEASE_TTL_SECONDS);
    assert.equal(validateTtlSeconds(1), 1);
    assert.equal(validateTtlSeconds(MAX_LEASE_TTL_SECONDS), MAX_LEASE_TTL_SECONDS);
    assert.throws(() => validateTtlSeconds(0), ValidationError);
    assert.throws(() => validateTtlSeconds(-10), ValidationError);
    assert.throws(() => validateTtlSeconds(MAX_LEASE_TTL_SECONDS + 1), ValidationError);
    assert.throws(() => validateTtlSeconds(12.5), ValidationError);
  });

  it('resolves relay directory from CLI arg, environment variable, or home directory', () => {
    assert.equal(resolveRelayDir('./custom-relay', './env-relay'), path.resolve('./custom-relay'));
    assert.equal(resolveRelayDir(undefined, './env-relay'), path.resolve('./env-relay'));

    const prevEnv = process.env.AGENT_RELAY_DIR;
    try {
      delete process.env.AGENT_RELAY_DIR;
      assert.equal(resolveRelayDir(), path.join(os.homedir(), '.agent-relay'));
    } finally {
      if (prevEnv !== undefined) {
        process.env.AGENT_RELAY_DIR = prevEnv;
      }
    }
  });

  it('escapes all HTML special characters against XSS', () => {
    const payload = `<script>alert("xss" & 'single')</script>`;
    assert.equal(
      escapeHtml(payload),
      '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;single&#39;)&lt;/script&gt;'
    );
  });
});
