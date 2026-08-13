import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { requestEnvelope, redactSecrets, sanitizeError, validateEnvelope, readJson } from '../lib/protocol.mjs';
import { promptRevision, validatePrompt, validateRevision } from '../lib/revision.mjs';

describe('prompt revisions', () => {
  const prompt = { id: 'welcome', title: 'Welcome', content: 'Say hello' };

  it('uses the frozen SHA-256 field order', () => {
    assert.equal(promptRevision(prompt), '8ca705600e0756b8085030cb4775834e265a888bef3c820cdf2f71f7d33a0793');
  });

  it('adds a matching revision to valid prompt input', () => {
    assert.deepEqual(validatePrompt(prompt), { ...prompt, revision: promptRevision(prompt) });
  });

  it('rejects missing, extra, oversized, and malformed fields', () => {
    assert.throws(() => validatePrompt({ title: 'x', content: 'y' }), error => error.code === 'CLI_INVALID_PROMPT');
    assert.throws(() => validatePrompt({ ...prompt, extra: true }), error => error.code === 'CLI_INVALID_PROMPT');
    assert.throws(() => validatePrompt({ ...prompt, content: 'x'.repeat(1024 * 1024 + 1) }), error => error.code === 'CLI_INVALID_PROMPT');
    assert.throws(() => validatePrompt({ ...prompt, id: '../bad' }), error => error.code === 'CLI_INVALID_PROMPT');
  });

  it('rejects a revision that does not match the prompt', () => {
    assert.throws(() => validatePrompt({ ...prompt, revision: '0'.repeat(64) }), error => error.code === 'CLI_INVALID_REVISION');
    assert.throws(() => validateRevision('ABC'), error => error.code === 'CLI_INVALID_REVISION');
  });
});

describe('protocol envelopes', () => {
  it('creates and validates a versioned envelope', () => {
    const value = requestEnvelope('browser.poll', { waitMs: 0 });
    assert.equal(validateEnvelope(value, ['browser.poll']), value);
  });

  it('returns CLI_INCOMPATIBLE for another protocol version', () => {
    const value = { ...requestEnvelope('browser.poll', { waitMs: 0 }), protocol: 'promptpie.local/v2' };
    assert.throws(() => validateEnvelope(value, ['browser.poll']), error => error.code === 'CLI_INCOMPATIBLE');
  });

  it('strictly rejects unknown fields and malformed ids', () => {
    assert.throws(() => validateEnvelope({ ...requestEnvelope('browser.poll', {}), extra: true }, ['browser.poll']), error => error.code === 'CLI_MALFORMED_REQUEST');
    assert.throws(() => validateEnvelope({ ...requestEnvelope('browser.poll', {}), requestId: 'short' }, ['browser.poll']), error => error.code === 'CLI_MALFORMED_REQUEST');
  });

  it('rejects malformed and oversized JSON streams', async () => {
    const malformed = Readable.from(['{bad']);
    malformed.headers = { 'content-type': 'application/json' };
    await assert.rejects(readJson(malformed), error => error.code === 'CLI_MALFORMED_REQUEST');

    const oversized = Readable.from(['x'.repeat(12)]);
    oversized.headers = { 'content-type': 'application/json' };
    await assert.rejects(readJson(oversized, 10), error => error.code === 'CLI_PAYLOAD_TOO_LARGE');
  });
});

describe('secret redaction', () => {
  it('redacts bearer tokens and named secrets', () => {
    const text = redactSecrets('Authorization: Bearer abc123 token=secret nonce=value');
    assert.doesNotMatch(text, /abc123|secret|value/);
  });

  it('redacts nested error details', () => {
    const safe = sanitizeError({ code: 'CLI_REMOTE', message: 'sessionToken=abc', details: { token: 'def', nested: { nonce: 'ghi' } } });
    assert.equal(safe.details.token, '[REDACTED]');
    assert.equal(safe.details.nested.nonce, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(safe), /abc|def|ghi/);
  });
});
