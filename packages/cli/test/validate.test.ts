import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reference, root, run, scratch } from './run.js';

const dir = scratch('validate');

describe('epochnotes registry validate', () => {
  it('exits 0 on the reference entry and prints its leaf', async () => {
    const { code, out } = await run('registry', 'validate', `${root}registry/entries/tx-v1.yaml`);
    expect(code).toBe(0);
    expect(out).toMatch(/^OK .*tx-v1@1 {2}leaf [0-9a-f]{64}$/);
  });

  it('exits 0 on the whole entries directory', async () => {
    expect((await run('registry', 'validate', `${root}registry/entries`)).code).toBe(0);
  });

  it('exits 1 on a broken entry and says how to fix it', async () => {
    const file = join(dir, 'broken.yaml');
    writeFileSync(file, reference.replace('axis: protocol\n', 'axis: protocol\nstatus: active\n'));
    const { code, out } = await run('registry', 'validate', file);
    rmSync(file);
    expect(code).toBe(1);
    expect(out).toContain('fix: Remove it: activation status is never stored in an entry');
  });

  it('resolves relations of a single file against the entries next to it', async () => {
    const entry = join(dir, 'tx-v1.yaml');
    writeFileSync(
      entry,
      reference.replace('relations: []', 'relations:\n  - type: requires\n    id: slot-duration'),
    );
    const alone = await run('registry', 'validate', entry);
    expect(alone.code).toBe(1);
    expect(alone.out).toContain('No entry with id "slot-duration"');
    expect(alone.out).not.toMatch(/^OK /m);

    writeFileSync(join(dir, 'slot-duration.yaml'), 'id: slot-duration\n');
    const besideInvalid = await run('registry', 'validate', entry);
    expect(besideInvalid.code).toBe(1);
    expect(besideInvalid.out).toContain('Ignored as invalid');
    expect(besideInvalid.out).toContain('slot-duration.yaml');

    writeFileSync(join(dir, 'slot-duration.yaml'), reference.replace('id: tx-v1', 'id: slot-duration'));
    expect((await run('registry', 'validate', entry)).code).toBe(0);
    expect((await run('registry', 'validate', dir)).code).toBe(0);
  });

  it('exits 2 when the path cannot be read', async () => {
    expect((await run('registry', 'validate', `${root}no-such-file.yaml`)).code).toBe(2);
  });

  it('prints machine-readable JSON with --json', async () => {
    const { out } = await run('registry', 'validate', '--json', `${root}registry/entries/tx-v1.yaml`);
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: [{ id: 'tx-v1', rev: 1 }] });
    expect(Object.keys(JSON.parse(out).files[0]).sort()).toEqual([
      'file',
      'id',
      'issues',
      'leaf',
      'ok',
      'rev',
    ]);
  });
});
