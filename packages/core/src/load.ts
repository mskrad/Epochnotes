import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
  const single = files.length === 1 && files[0]?.file === path;
  // A single file is checked on its own: relations to entries outside it cannot be resolved.
  const registryIssues = single ? [] : validateRegistry(entries);
  return { ok: files.every((file) => file.ok) && registryIssues.length === 0, files, registryIssues };
}
