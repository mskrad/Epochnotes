// Holds corpus/manifest.yaml, the files of corpus/pairs and the detection engine against each other.
import { checkCorpus } from '../packages/core/dist/index.js';

const root = new URL('..', import.meta.url).pathname;
const report = checkCorpus(`${root}corpus`, `${root}registry/entries`);
for (const row of report.rows)
  console.log(
    `${row.detected ? 'found ' : 'MISSED'}  ${row.id.padEnd(40)} expects ${row.expected}; reported ${row.reported.join(', ') || 'nothing'}`,
  );
const { recall } = report;
console.log(
  `\nrecall on this corpus: ${recall.detected} of ${recall.of} cases; ${recall.repository.detected} of ${recall.repository.of} among the cases taken from repositories. Every miss has its reason in the manifest.`,
);
for (const problem of report.problems) console.error(`PROBLEM  ${problem}`);
console.log(
  report.problems.length === 0
    ? 'The manifest, the files and the engine agree.'
    : `${report.problems.length} problem(s).`,
);
process.exitCode = report.problems.length === 0 ? 0 : 1;
