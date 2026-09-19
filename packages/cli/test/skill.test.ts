import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { validatePath } from '@epochnotes/core';
import { describe, expect, it } from 'vitest';

import { root } from './run.js';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const skill = filesUnder(`${root}skills`).map((file) => ({ file, text: readFileSync(file, 'utf8') }));

/** Shapes a fact about a change would take. The skill reads such things from the registry; it never carries them. */
const factShapes: [string, RegExp][] = [
  ['a year or a date', /\b20\d\d\b/],
  ['a version number', /\b\d+\.\d+(\.\d+)?\b/],
  ['a SIMD number', /SIMD-?\s?\d+/i],
  ['a slot, an error code or another long number', /\d{3,}/],
  ['an address', /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/],
];

describe('the skill carries no facts about changes', () => {
  it('has files to check', () => {
    expect(skill.map(({ file }) => file.slice(root.length)).sort()).toEqual([
      'skills/epochnotes/SKILL.md',
      'skills/epochnotes/references/project-surfaces.md',
    ]);
  });

  it.each(factShapes)('contains nothing shaped like %s', (_name, shape) => {
    for (const { file, text } of skill)
      expect(
        text.split('\n').filter((line) => shape.test(line)),
        file,
      ).toEqual([]);
  });

  it('repeats no identifier, address, package or number from the registry entries', () => {
    const report = validatePath(`${root}registry/entries`);
    const literals = new Set<string>();
    for (const { entry } of report.files) {
      if (entry === undefined) throw new Error('the registry must be valid for this test to mean anything');
      literals.add(entry.id).add(entry.subject.name);
      for (const gate of entry.applies.gates ?? []) literals.add(gate.address).add(gate.label);
      for (const range of entry.applies.versions ?? []) literals.add(range.name);
      for (const rule of entry.detect) literals.add(rule.rule);
      for (const number of JSON.stringify(entry).match(/\d{3,}/g) ?? []) literals.add(number);
    }
    expect(literals.size).toBeGreaterThan(30);
    for (const { file, text } of skill)
      expect(
        [...literals].filter((literal) => text.includes(literal)),
        file,
      ).toEqual([]);
  });
});
