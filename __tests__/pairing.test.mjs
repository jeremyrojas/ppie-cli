import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NONCE_TTL_MS, consumeNonce, createPairingState, createSession, isAllowedRequestOrigin,
  validateAllowedOrigin, validateSession,
} from '../lib/pairing.mjs';

describe('allowed origins', () => {
  it('accepts production HTTPS and explicit loopback development origins', () => {
    assert.equal(validateAllowedOrigin('https://app.promptpie.dev'), 'https://app.promptpie.dev');
    assert.equal(validateAllowedOrigin('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(validateAllowedOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  });

  it('rejects paths, credentials, and non-loopback HTTP origins', () => {
    for (const origin of ['https://example.com/path', 'https://user@example.com', 'http://example.com', 'ftp://localhost', 'javascript:alert(1)']) {
      assert.throws(() => validateAllowedOrigin(origin), error => error.code === 'CLI_INVALID_ORIGIN');
    }
  });

  it('matches request origins exactly', () => {
    assert.equal(isAllowedRequestOrigin('http://localhost:3000', 'http://localhost:3000'), true);
    assert.equal(isAllowedRequestOrigin('http://localhost:3001', 'http://localhost:3000'), false);
    assert.equal(isAllowedRequestOrigin(undefined, 'http://localhost:3000'), false);
  });
});

describe('pairing nonce and session', () => {
  it('consumes a nonce once', () => {
    const state = createPairingState(1_000);
    assert.equal(consumeNonce(state, state.nonce, 1_001), true);
    assert.throws(() => consumeNonce(state, state.nonce, 1_002), error => error.code === 'CLI_PAIRING_REPLAY');
  });

  it('rejects expired and incorrect nonces', () => {
    const expired = createPairingState(1_000);
    assert.throws(() => consumeNonce(expired, expired.nonce, 1_000 + NONCE_TTL_MS + 1), error => error.code === 'CLI_PAIRING_EXPIRED');
    const wrong = createPairingState(1_000);
    assert.throws(() => consumeNonce(wrong, 'wrong', 1_001), error => error.code === 'CLI_PAIRING_REJECTED');
  });

  it('validates session tokens without exposing them in errors', () => {
    const session = createSession(1_000);
    assert.equal(validateSession(session, session.token, 1_001), session);
    assert.throws(() => validateSession(session, 'wrong', 1_001), error => error.code === 'CLI_NOT_PAIRED' && !error.message.includes(session.token));
    assert.throws(() => validateSession(session, session.token, session.expiresAt + 1), error => error.code === 'CLI_NOT_PAIRED');
  });
});
