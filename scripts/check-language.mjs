// Everything that ships is written in English: fails when a tracked file contains Cyrillic text.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  if (text.includes('\0')) continue; // binary
  text.split('\n').forEach((line, index) => {
    if (/[\u0400-\u04FF]/.test(line)) findings.push(`${file}:${index + 1}: ${line.trim().slice(0, 80)}`);
  });
}
if (findings.length > 0) {
  console.error(`Non-English text in tracked files:\n${findings.join('\n')}`);
  process.exit(1);
}
