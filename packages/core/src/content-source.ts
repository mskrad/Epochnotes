/*
 * Reads content that a signed manifest committed to by hash, without trusting whoever serves it.
 * Ported from the Verifiable Outcome Engine SDK (MIT, github.com/mskrad/verifiable-outcome-engine,
 * sdk/snapshot_source.ts at commit 3f24f675d029): try each source in order, accept the first whose
 * sha256 equals the committed hash, and report every attempt when none does.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONTENT_TIMEOUT_MS = 20_000;
export const DEFAULT_CONTENT_MAX_BYTES = 64 * 1024 * 1024;

export interface ContentAttempt {
  source: string;
  outcome: 'ok' | 'hash_mismatch' | 'http_error' | 'timeout' | 'too_large' | 'unsupported' | 'error';
  detail?: string;
}

export class ContentUnavailableError extends Error {
  constructor(readonly attempts: ContentAttempt[]) {
    const tried = attempts
      .map((a) => `${a.source} -> ${a.outcome}${a.detail ? ` (${a.detail})` : ''}`)
      .join('; ');
    super(`No source served the committed content: ${tried || 'no sources'}`);
    this.name = 'ContentUnavailableError';
  }
}

class ReadFailure extends Error {
  constructor(
    readonly outcome: ContentAttempt['outcome'],
    message: string,
  ) {
    super(message);
  }
}

/** Where committed content can be read, in order: the committed URI, then `<mirror>/sha256/<hash>.jsonl`. */
export function contentSourceCandidates(uri: string, hash: string, mirrors: string[] = []): string[] {
  const out = uri.trim() ? [uri.trim()] : [];
  for (const mirror of mirrors) {
    const base = mirror.trim().replace(/\/+$/, '');
    if (base) out.push(`${base}/sha256/${hash}.jsonl`);
  }
  return [...new Set(out)];
}

async function readHttp(url: string, timeoutMs: number, maxBytes: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new ReadFailure('http_error', `HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new ReadFailure('too_large', `${declared} bytes`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new ReadFailure('too_large', `over ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    if (controller.signal.aborted) throw new ReadFailure('timeout', `no answer in ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readLocal(source: string, maxBytes: number): Uint8Array {
  const path = /^file:\/\//i.test(source)
    ? fileURLToPath(source)
    : isAbsolute(source)
      ? source
      : resolve(source);
  const size = statSync(path).size;
  if (size > maxBytes) throw new ReadFailure('too_large', `${size} bytes`);
  return readFileSync(path);
}

/**
 * Reads the bytes whose sha256 is `hash`: an explicit local copy first, then the committed URI, then
 * hash-addressed mirrors. A source counts only if what it served hashes to `hash`.
 */
export async function fetchCommittedContent(options: {
  uri: string;
  hash: string;
  localFile?: string;
  mirrors?: string[];
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<{ bytes: Uint8Array; source: string; attempts: ContentAttempt[] }> {
  const expected = options.hash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new TypeError('hash must be 32 bytes as hex');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTENT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_CONTENT_MAX_BYTES;
  const sources = [
    ...(options.localFile === undefined ? [] : [options.localFile]),
    ...contentSourceCandidates(options.uri, expected, options.mirrors),
  ];
  const attempts: ContentAttempt[] = [];
  for (const source of new Set(sources)) {
    let bytes: Uint8Array;
    try {
      if (/^https?:\/\//i.test(source)) bytes = await readHttp(source, timeoutMs, maxBytes);
      else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !/^file:\/\//i.test(source)) {
        attempts.push({ source, outcome: 'unsupported', detail: 'unknown URI scheme' });
        continue;
      } else bytes = readLocal(source, maxBytes);
    } catch (error) {
      attempts.push({
        source,
        outcome: error instanceof ReadFailure ? error.outcome : 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
      attempts.push({ source, outcome: 'hash_mismatch', detail: `sha256 ${actual.slice(0, 16)}...` });
      continue;
    }
    attempts.push({ source, outcome: 'ok' });
    return { bytes, source, attempts };
  }
  throw new ContentUnavailableError(attempts);
}
