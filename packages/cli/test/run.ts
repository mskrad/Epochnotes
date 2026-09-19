import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, vi } from 'vitest';

import { main } from '../src/main.js';

export const root = new URL('../../../', import.meta.url).pathname;
export const reference = readFileSync(`${root}registry/entries/tx-v1.yaml`, 'utf8');

export interface Run {
  code: number;
  /** stdout and stderr in the order they were written. */
  out: string;
  stdout: string;
  stderr: string;
}

/** Runs the CLI through its real entry point, `main`, and captures what it wrote and the exit code it chose. */
export async function run(...args: string[]): Promise<Run> {
  const all: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const to = (sink: string[]) => (chunk: unknown) => {
    const text = String(chunk).replace(/\n$/, '');
    sink.push(text);
    all.push(text);
    return true;
  };
  vi.spyOn(console, 'log').mockImplementation(to(stdout));
  vi.spyOn(console, 'error').mockImplementation(to(stderr));
  vi.spyOn(process.stdout, 'write').mockImplementation(to(stdout));
  vi.spyOn(process.stderr, 'write').mockImplementation(to(stderr));
  try {
    const code = await main(['node', 'epochnotes', ...args]);
    return { code, out: all.join('\n'), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
}

/** A scratch directory for one test file, removed when the file is done. */
export function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `epochnotes-${name}-`));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
