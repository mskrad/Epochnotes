import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { entryLeafHash, toHex } from './canonical.js';
import type { Entry } from './schema.js';
import { type Issue, validateEntryYaml, validateRegistry } from './validate.js';

export interface FileReport {
  file: string;
  ok: boolean;
  id?: string;
  rev?: number;
  leaf?: string;
  issues: Issue[];
}

export interface RegistryReport {
  ok: boolean;
  files: FileReport[];
  /** Problems that span entries: duplicate ids, unresolved relations, cycles. */
  registryIssues: Issue[];
}

function entryFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => join(path, name));
}

/** Validates an entry file, or every `.yaml` entry in a directory together with cross-entry checks. */
export function validatePath(path: string): RegistryReport {
  const entries: Entry[] = [];
  const files = entryFiles(path).map((file): FileReport => {
    const result = validateEntryYaml(readFileSync(file, 'utf8'));
    if (!result.ok) return { file, ok: false, issues: result.issues };
    entries.push(result.entry);
    return {
      file,
      ok: true,
      id: result.entry.id,
      rev: result.entry.rev,
      leaf: toHex(entryLeafHash(result.entry)),
      issues: [],
    };
  });
  let registryIssues = validateRegistry(entries);
  const only = entries[0];
  if (!statSync(path).isDirectory() && only !== undefined) {
    // A single file is checked in the context of its directory, so its relations still have to resolve;
    // problems that belong to the neighbours alone are left to a directory run.
    const neighbours = entryFiles(dirname(path))
      .filter((file) => resolve(file) !== resolve(path))
      .map((file) => ({ file, result: validateEntryYaml(readFileSync(file, 'utf8')) }));
    const valid = neighbours.flatMap(({ result }) => (result.ok ? [result.entry] : []));
    const invalid = neighbours.filter(({ result }) => !result.ok).map(({ file }) => file);
    registryIssues = validateRegistry([only, ...valid])
      .filter((issue) => issue.path === only.id || issue.path.startsWith(`${only.id}.`))
      .map((issue) =>
        invalid.length > 0 && issue.code === 'unresolved-relation'
          ? {
              ...issue,
              hint: `${issue.hint} Ignored as invalid: ${invalid.join(', ')} — the id may live there.`,
            }
          : issue,
      );
  }
  return { ok: files.every((file) => file.ok) && registryIssues.length === 0, files, registryIssues };
}
