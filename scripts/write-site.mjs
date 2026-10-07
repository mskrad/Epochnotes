import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderSite, siteWatchOf, validatePath } from '../packages/core/dist/index.js';

const root = new URL('..', import.meta.url);
const watchFile = new URL('site/watch.json', root);

function refuse(message) {
  console.error(message);
  process.exit(2);
}

function newReading() {
  const flag = process.argv.indexOf('--watch-report');
  if (flag === -1) return undefined;
  const reportPath = process.argv[flag + 1];
  if (reportPath === undefined)
    refuse('--watch-report takes the path of a report.json written by epochnotes watch solana');
  try {
    return { reportPath, watch: siteWatchOf(JSON.parse(readFileSync(reportPath, 'utf8'))) };
  } catch (error) {
    refuse(`${reportPath} is not a report written by epochnotes watch solana: ${error.message}`);
  }
}

const reading = newReading();
const registry = validatePath(new URL('registry/entries', root).pathname);
if (registry.files.some((file) => file.entry === undefined))
  refuse('The registry does not validate: run epochnotes registry validate registry/entries');
const entries = registry.files.map((file) => file.entry);
const watch =
  reading?.watch ?? (existsSync(watchFile) ? JSON.parse(readFileSync(watchFile, 'utf8')) : undefined);
let page;
try {
  page = renderSite(entries, watch);
} catch (error) {
  refuse(
    `${reading?.reportPath ?? 'site/watch.json'} is not a report written by epochnotes watch solana: ${error.message}`,
  );
}
if (reading !== undefined) {
  mkdirSync(new URL('site/', root), { recursive: true });
  writeFileSync(watchFile, `${JSON.stringify(reading.watch, null, 2)}\n`);
}
writeFileSync(new URL('index.html', root), page);
console.log(
  `index.html: ${entries.length} entries${watch === undefined ? '' : `, watcher report of ${watch.agave.retrieved}`}`,
);
