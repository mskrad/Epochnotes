import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Entry, validateEntry } from '../src/index.js';

const root = new URL('../../../', import.meta.url).pathname;

/** The entries as they stand in the repository: what the next version of the signed log would hold. */
export const liveEntries = `${root}registry/entries`;

/**
 * A copy of the live entries with every rev set to 1, in `directory`. A log that a test starts from nothing takes
 * a new id only at rev 1, while the live entries carry the revisions of the signed log.
 */
export function firstVersionEntries(directory: string): string {
  mkdirSync(directory, { recursive: true });
  cpSync(liveEntries, directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^rev: \d+$/m, 'rev: 1'));
  }
  return directory;
}

/** The entries of version 1 of the signed log, as they were signed. */
export function signedVersionOneEntries(): Entry[] {
  const versions = `${root}registry/versions`;
  const { merkle_root: merkleRoot } = JSON.parse(readFileSync(join(versions, '1.json'), 'utf8')) as {
    merkle_root: string;
  };
  return readFileSync(join(versions, `${merkleRoot}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const result = validateEntry(JSON.parse(line));
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return result.entry;
    });
}
