import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, vi } from 'vitest';

import { buildProgram } from '../src/program.js';

export const root = new URL('../../../', import.meta.url).pathname;
export const reference = readFileSync(`${root}registry/entries/tx-v1.yaml`, 'utf8');

/**
 * Runs the CLI in-process and returns its exit code and everything it printed. A usage error surfaces the
 * way bin.ts treats it: exit code 2.
 */
export async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
  process.exitCode = undefined;
  let code: number;
  try {
    await buildProgram().parseAsync(['node', 'epochnotes', ...args]);
    code = Number(process.exitCode ?? 0);
  } catch (error) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    if (exitCode === undefined) throw error;
    code = exitCode === 0 ? 0 : 2;
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { code, out: lines.join('\n') };
}

/** A scratch directory for one test file, removed when the file is done. */
export function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `epochnotes-${name}-`));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => vi.restoreAllMocks());
