// End-to-end run of the built CLI, the way a user would call it. `npm run e2e` builds first.
// Talks to devnet for the status step; set E2E_OFFLINE=1 to skip that one step.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const cli = join(root, 'packages/cli/bin/epochnotes.js');
const work = mkdtempSync(join(tmpdir(), 'epochnotes-e2e-'));
const versions = join(work, 'versions');
const entries = join(work, 'entries');
const failures = [];
let steps = 0;

function step(name, args, expectedCode, check) {
  steps += 1;
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  let problem =
    result.status === expectedCode ? undefined : `exit ${result.status}, expected ${expectedCode}`;
  if (problem === undefined && check !== undefined) {
    try {
      problem = check(output, result.stdout);
    } catch (error) {
      problem = String(error);
    }
  }
  console.log(
    `${problem === undefined ? 'ok  ' : 'FAIL'} ${String(steps).padStart(2)}. ${name}${problem === undefined ? '' : ` — ${problem}`}`,
  );
  if (problem !== undefined) failures.push({ name, problem, output: output.slice(0, 800) });
  return output;
}

const has = (text) => (output) => (output.includes(text) ? undefined : `output lacks "${text}"`);

try {
  // a throwaway publisher key in solana-keygen format
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyFile = join(work, 'publisher.json');
  writeFileSync(
    keyFile,
    JSON.stringify([
      ...privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
      ...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ]),
  );
  cpSync(join(root, 'registry/entries'), entries, { recursive: true });
  const publishArgs = [
    'registry',
    'publish',
    '--key',
    keyFile,
    '--entries',
    entries,
    '--versions',
    versions,
    '--uri',
    join(versions, '{root}.jsonl'),
  ];

  const { version } = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
  step('prints the version of its package.json', ['--version'], 0, has(`${version} (entry schema 1)`));
  step('validates the registry', ['registry', 'validate', 'registry/entries'], 0, has('tx-v1@'));
  step('dry-run publishes without writing', [...publishArgs, '--dry-run'], 0, () =>
    existsSync(versions) ? 'the versions directory was created' : undefined,
  );
  const published = step('publishes version 1', [...publishArgs, '--json'], 0, (_all, stdout) =>
    JSON.parse(stdout).manifest.n === 1 ? undefined : 'not version 1',
  );
  step('has nothing to publish the second time', publishArgs, 0, has('Nothing to publish'));

  const publisher = JSON.parse(published.slice(published.indexOf('{'))).manifest.publisher;
  const publishers = join(work, 'publishers.json');
  writeFileSync(
    publishers,
    JSON.stringify({ publishers: [{ name: 'e2e', key: publisher, status: 'active' }] }),
  );
  const verifyArgs = ['registry', 'verify', 'tx-v1', '--versions', versions, '--publishers', publishers];
  step('proves an entry against the signed log', verifyArgs, 0, has('is in version 1'));
  step('prints the proof as JSON', [...verifyArgs, '--json'], 0, (_all, stdout) =>
    Array.isArray(JSON.parse(stdout).proof.proof) ? undefined : 'no proof in JSON',
  );
  step(
    'does not trust the repository publisher list for a foreign key',
    ['registry', 'verify', 'tx-v1', '--versions', versions],
    1,
    has('is not trusted'),
  );

  const manifest = join(versions, '1.json');
  const original = readFileSync(manifest, 'utf8');
  writeFileSync(manifest, original.replace('"entry_count": 4', '"entry_count": 5'));
  step('refuses a manifest altered after signing', verifyArgs, 1, has('Signature does not match'));
  writeFileSync(manifest, original);

  const broken = join(work, 'repo-before');
  const fixed = join(work, 'repo-after');
  for (const [dir, value] of [
    [broken, 0],
    [fixed, 1],
  ]) {
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'reader.ts'),
      `await connection.getTransaction(sig, { maxSupportedTransactionVersion: ${value} });\n`,
    );
  }
  step('finds the break in code before the fix', ['check', 'repo', broken], 1, has('reader.ts:1'));
  step('is silent on code after the fix', ['check', 'repo', fixed], 0, has('0 finding(s)'));
  step('treats a usage error as 2, not as findings', ['registry', 'verify'], 2);
  step('treats an unreadable path as 2', ['check', 'repo', join(work, 'absent')], 2);

  if (process.env.E2E_OFFLINE === '1')
    console.log('SKIP     status on devnet (E2E_OFFLINE=1): this run does not cover the network step');
  else {
    step(
      'reads the status of every gate from devnet, as JSON',
      ['status', '--cluster', 'devnet', '--json'],
      0,
      (_all, stdout) => {
        const report = JSON.parse(stdout);
        if (report.cluster !== 'devnet' || !/^\d+$/.test(report.slot))
          return 'no cluster or slot in the report';
        return report.gates.length >= 11 && report.gates.every((gate) => gate.address && gate.status?.state)
          ? undefined
          : 'gates are missing a status';
      },
    );
  }
} catch (error) {
  failures.push({ name: 'the scenario itself', problem: String(error), output: '' });
} finally {
  // the scratch directory holds a private key, throwaway or not
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${steps - failures.length} of ${steps} steps passed.`);
for (const failure of failures) console.log(`\n--- ${failure.name}: ${failure.problem}\n${failure.output}`);
process.exit(failures.length === 0 ? 0 : 1);
