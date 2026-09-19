import { GENESIS, redactUrl } from './onchain.js';
import type { Entry } from './schema.js';

export interface ProbeCall {
  /** What was passed as `maxSupportedTransactionVersion`. */
  parameter: 'omitted' | 0 | 1;
  /** `version N` on success, or the JSON-RPC error. */
  outcome: { ok: true; version: string } | { ok: false; code: number | null; message: string };
}

export interface ProbeResult {
  entry: string;
  rule: string;
  fixture: string;
  /** What the entry expects, in its own words: the engine reports observations and leaves the reading to them. */
  expect: string;
  verdict: 'reads' | 'cannot-read' | 'fixture-missing' | 'not-applicable' | 'unreachable';
  explanation: string;
  calls: ProbeCall[];
}

export interface RpcProbeReport {
  endpoint: string;
  cluster: string;
  probes: ProbeResult[];
}

type Rpc = (
  method: string,
  params: unknown[],
) => Promise<{ result?: unknown; error?: { code?: number; message?: string } }>;

function httpRpc(rpcUrl: string): Rpc {
  return async (method, params) => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as Awaited<ReturnType<Rpc>>;
  };
}

/**
 * Runs the read-only runtime probes of the entries against one RPC endpoint. A registry entry records how
 * the reference RPC behaves; a provider may differ, and only asking it tells. Nothing is written, nothing is
 * signed, no key is involved: each probe is a few `getTransaction` reads of a known public transaction.
 */
export async function probeRpc(
  rpcUrl: string,
  entries: Entry[],
  rpc: Rpc = httpRpc(rpcUrl),
): Promise<RpcProbeReport> {
  const endpoint = redactUrl(rpcUrl);
  const probes: ProbeResult[] = [];
  let genesis: string;
  try {
    genesis = String((await rpc('getGenesisHash', [])).result);
  } catch (error) {
    const explanation = `The endpoint did not answer: ${error instanceof Error ? error.message : String(error)}`;
    return {
      endpoint,
      cluster: 'unknown',
      probes: [
        { entry: '-', rule: '-', fixture: '-', expect: '-', verdict: 'unreachable', explanation, calls: [] },
      ],
    };
  }
  const cluster = Object.entries(GENESIS).find(([, hash]) => hash === genesis)?.[0] ?? 'unknown';

  for (const entry of entries) {
    for (const rule of entry.detect) {
      if (rule.kind !== 'runtime-probe') continue;
      const fixture = rule.probe.fixture ?? '';
      const [fixtureCluster, signature] = fixture.split(':');
      const base = { entry: entry.id, rule: rule.rule, fixture, expect: rule.probe.expect };
      if (rule.probe.method !== 'getTransaction' || signature === undefined) {
        probes.push({
          ...base,
          verdict: 'not-applicable',
          explanation: `This tool cannot run a probe of ${rule.probe.method}.`,
          calls: [],
        });
        continue;
      }
      if (fixtureCluster !== cluster) {
        probes.push({
          ...base,
          verdict: 'not-applicable',
          explanation: `The fixture lives on ${fixtureCluster}, the endpoint serves ${cluster}.`,
          calls: [],
        });
        continue;
      }
      const calls: ProbeCall[] = [];
      try {
        for (const parameter of ['omitted', 0, 1] as const) {
          const config =
            parameter === 'omitted'
              ? { encoding: 'base64' }
              : { encoding: 'base64', maxSupportedTransactionVersion: parameter };
          const answer = await rpc('getTransaction', [signature, config]);
          if (answer.error !== undefined)
            calls.push({
              parameter,
              outcome: { ok: false, code: answer.error.code ?? null, message: answer.error.message ?? '' },
            });
          else if (answer.result === null || answer.result === undefined)
            calls.push({
              parameter,
              outcome: { ok: false, code: null, message: 'transaction not found on this endpoint' },
            });
          else
            calls.push({
              parameter,
              outcome: { ok: true, version: String((answer.result as { version?: unknown }).version) },
            });
        }
      } catch (error) {
        probes.push({
          ...base,
          verdict: 'unreachable',
          explanation: `The endpoint stopped answering: ${error instanceof Error ? error.message : String(error)}`,
          calls,
        });
        continue;
      }
      const reads = calls.filter((call) => call.outcome.ok).map((call) => String(call.parameter));
      const missing = calls.every((call) => !call.outcome.ok && call.outcome.code === null);
      probes.push({
        ...base,
        verdict: missing ? 'fixture-missing' : reads.length > 0 ? 'reads' : 'cannot-read',
        explanation: missing
          ? 'The endpoint does not have the fixture transaction (pruned history?), so its behaviour could not be observed.'
          : reads.length > 0
            ? `The endpoint returns the fixture with maxSupportedTransactionVersion ${reads.join(', ')}; see the calls for what it refuses.`
            : 'The endpoint has the fixture but returns it with no setting of maxSupportedTransactionVersion.',
        calls,
      });
    }
  }
  return { endpoint, cluster, probes };
}
