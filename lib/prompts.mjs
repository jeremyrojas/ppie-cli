import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { createError } from './errors.mjs';
import { submitCompanionOperation } from './companion.mjs';
import { MAX_CONTENT_BYTES, MAX_TITLE_BYTES, validatePrompt, validateRevision } from './revision.mjs';

const MAX_PROMPT_FILE_BYTES = MAX_CONTENT_BYTES + MAX_TITLE_BYTES + 16 * 1024;

export function readPromptInput(file) {
  let source;
  if (file === '-') {
    try { source = readBoundedFd(0, MAX_PROMPT_FILE_BYTES); } catch (error) {
      if (error.code === 'CLI_PAYLOAD_TOO_LARGE') throw error;
      throw createError('CLI_PROMPT_FILE_ERROR', 'Unable to read prompt JSON from stdin.', { reason: error.code });
    }
  } else {
    let fd;
    try {
      fd = openSync(file, 'r');
      source = readBoundedFd(fd, MAX_PROMPT_FILE_BYTES);
    } catch (error) {
      if (error.code === 'CLI_PAYLOAD_TOO_LARGE') throw error;
      throw createError('CLI_PROMPT_FILE_ERROR', `Unable to read prompt file: ${file}.`, { path: file, reason: error.code });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  let value;
  try { value = JSON.parse(source.toString('utf8')); } catch { throw createError('CLI_INVALID_PROMPT', 'Prompt input contains malformed JSON.'); }
  return validatePrompt(value);
}

function readBoundedFd(fd, limit) {
  const size = fstatSync(fd).size;
  if (size > limit) throw createError('CLI_PAYLOAD_TOO_LARGE', `Prompt input exceeds ${limit} bytes.`);
  const chunks = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) throw createError('CLI_PAYLOAD_TOO_LARGE', `Prompt input exceeds ${limit} bytes.`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

export async function pushPrompt(prompt, { expectedRevision = null } = {}) {
  const operation = {
    operationId: randomUUID(),
    kind: 'prompt.push',
    prompt: validatePrompt(prompt),
    expectedRevision: expectedRevision === null ? null : validateRevision(expectedRevision, 'expectedRevision'),
  };
  return submitCompanionOperation(operation);
}

export async function pullPrompt(promptId) {
  if (typeof promptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(promptId)) {
    throw createError('CLI_INVALID_PROMPT', 'Prompt id must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.');
  }
  return submitCompanionOperation({ operationId: randomUUID(), kind: 'prompt.pull', promptId });
}

export function writePromptOutput(prompt, output) {
  const content = `${JSON.stringify(validatePrompt(prompt, { requireRevision: true }), null, 2)}\n`;
  if (!output) return content;
  try { writeFileSync(output, content, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    const message = error.code === 'EEXIST' ? `Output file already exists: ${output}.` : `Unable to write output file: ${output}.`;
    throw createError('CLI_OUTPUT_ERROR', message, { path: output, reason: error.code });
  }
  return null;
}
