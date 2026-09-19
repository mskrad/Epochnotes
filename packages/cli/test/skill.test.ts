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
  ['a hexadecimal value', /\b0x[0-9a-f]+\b/i],
  ['a month', /\b(january|february|march|april|june|july|august|september|october|november|december)\b/i],
];

// What this cannot catch: a fact written as plain prose ("votes move off chain"). Shapes and the registry's own
// vocabulary are checked here; prose is checked by reading the skill in review.
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

  it('repeats nothing the entries name: ids, subjects, titles, gates, packages, rules, code identifiers, numbers', () => {
    const report = validatePath(`${root}registry/entries`);
    const literals = new Set<string>();
    for (const { entry } of report.files) {
      if (entry === undefined) throw new Error('the registry must be valid for this test to mean anything');
      literals.add(entry.id).add(entry.subject.name).add(entry.subject.title);
      for (const gate of entry.applies.gates ?? []) literals.add(gate.address).add(gate.label);
      for (const range of entry.applies.versions ?? []) literals.add(range.name);
      for (const rule of entry.detect) literals.add(rule.rule);
      const everything = JSON.stringify(entry);
      for (const number of everything.match(/\d{3,}/g) ?? []) literals.add(number);
      // Code identifiers the entries quote: camelCase and snake_case names, scoped packages.
      const identifiers = /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|@[\w-]+\/[\w.-]+/g;
      for (const name of everything.match(identifiers) ?? []) literals.add(name);
      // Type names (PascalCase with an inner capital) and package names without their scope.
      for (const name of everything.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) ?? []) literals.add(name);
      for (const name of everything.match(/@[\w-]+\/[\w.-]+/g) ?? [])
        literals.add(name.slice(name.indexOf('/') + 1));
    }
    expect(literals.size).toBeGreaterThan(60);
    for (const { file, text } of skill)
      expect(
        [...literals].filter((literal) => text.toLowerCase().includes(literal.toLowerCase())),
        file,
      ).toEqual([]);
  });
});
