import { createHash } from 'node:crypto';
import { createError } from './errors.mjs';

const PROMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_TITLE_BYTES = 4 * 1024;
export const MAX_CONTENT_BYTES = 1024 * 1024;

export function promptRevision(prompt) {
  const value = JSON.stringify({ id: prompt.id, title: prompt.title, content: prompt.content });
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validatePrompt(value, { requireRevision = false } = {}) {
  if (!isRecord(value)) throw createError('CLI_INVALID_PROMPT', 'Prompt must be a JSON object.');
  assertExactKeys(value, requireRevision ? ['id', 'title', 'content', 'revision'] : ['id', 'title', 'content', 'revision'], ['id', 'title', 'content']);
  if (typeof value.id !== 'string' || !PROMPT_ID_PATTERN.test(value.id)) {
    throw createError('CLI_INVALID_PROMPT', 'Prompt id must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.');
  }
  if (typeof value.title !== 'string' || Buffer.byteLength(value.title) > MAX_TITLE_BYTES) {
    throw createError('CLI_INVALID_PROMPT', `Prompt title must be a string no larger than ${MAX_TITLE_BYTES} bytes.`);
  }
  if (typeof value.content !== 'string' || Buffer.byteLength(value.content) > MAX_CONTENT_BYTES) {
    throw createError('CLI_INVALID_PROMPT', `Prompt content must be a string no larger than ${MAX_CONTENT_BYTES} bytes.`);
  }
  const revision = promptRevision(value);
  if (requireRevision && typeof value.revision !== 'string') {
    throw createError('CLI_INVALID_PROMPT', 'Prompt revision is required.');
  }
  if (value.revision !== undefined && (!REVISION_PATTERN.test(value.revision) || value.revision !== revision)) {
    throw createError('CLI_INVALID_REVISION', 'Prompt revision does not match its id, title, and content.');
  }
  return { id: value.id, title: value.title, content: value.content, revision };
}

export function validateRevision(value, field = 'revision') {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw createError('CLI_INVALID_REVISION', `${field} must be a lowercase SHA-256 hex value.`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, required) {
  const keys = Object.keys(value);
  const extra = keys.find(key => !allowed.includes(key));
  if (extra) throw createError('CLI_INVALID_PROMPT', `Unknown prompt field: ${extra}.`);
  const missing = required.find(key => !Object.hasOwn(value, key));
  if (missing) throw createError('CLI_INVALID_PROMPT', `Missing prompt field: ${missing}.`);
}
