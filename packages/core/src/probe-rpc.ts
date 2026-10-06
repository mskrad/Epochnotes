import { chainNameOf, SOLANA_CHAINS, solanaChainId } from './chains.js';
import { evmActivationReader } from './evm-activation.js';
import { redactUrl } from './onchain.js';
import { type Entry, PROBE_METHODS, probeOf } from './schema.js';

export interface ProbeCall {
  /** The id the entry gives the call. */
  call: string;
  method: string;
  /** What the entry asked to record, on success; the JSON-RPC error, or the absence of the transaction. */
  outcome:
    { ok: true; observed: Record<string, unknown> } | { ok: false; code: number | null; message: string };
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
  /** The CAIP-2 id of the chain the endpoint serves, as it says itself, or `unknown`. */
  chain: string;
  name?: string;
  /** How many probes actually saw the endpoint behave. Zero means nothing was learned: that is not a pass. */
  observed: number;
  probes: ProbeResult[];
}

/** Transport errors quote the endpoint, credentials included: keep the reason, drop the URL. */
function reason(error: unknown, rpcUrl: string): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .split(rpcUrl)
    .join(redactUrl(rpcUrl))
    .replace(/https?:\/\/[^\s'"]+/g, (url) => redactUrl(url));
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

/** A value at a path of an answer: `result.version`, `result.authorizationList.length`. */
function at(answer: unknown, path: string): unknown {
  let value: unknown = answer;
  for (const key of path.split('.')) {
    if (value === null || value === undefined) return undefined;
    if (key === 'length' && Array.isArray(value)) return value.length;
    if (typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** What a report may carry of a value: scalars as they are, the size of an array, the kind of anything else. */
function recordable(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return Array.isArray(value) ? `array of ${value.length}` : typeof value;
}

/**
 * Which chain an endpoint serves, as it says itself: Solana by its genesis hash, an EVM chain by its chain id
 * and, where pinned, its genesis block. An endpoint that answers neither is `unknown`; one that does not answer
 * at all is a transport failure, thrown.
 */
async function identifyEndpoint(rpc: Rpc): Promise<string> {
  // Some EVM endpoints refuse a method they do not know at the HTTP level rather than with a JSON-RPC error, so
  // a failed Solana question is not yet a dead endpoint: it is dead only if it answers neither question.
  let solanaFailure: unknown;
  try {
    const first = await rpc('getGenesisHash', []);
    if (
      first.error === undefined &&
      typeof first.result === 'string' &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(first.result)
    )
      return solanaChainId(first.result);
  } catch (error) {
    solanaFailure = error;
  }
  let evmFailure: unknown;
  try {
    const chainId = await rpc('eth_chainId', []);
    if (chainId.error !== undefined) return 'unknown';
  } catch (error) {
    evmFailure = error;
  }
  if (evmFailure !== undefined) throw solanaFailure ?? evmFailure;
  try {
    return (await evmActivationReader(rpc).identify()).chain;
  } catch {
    return 'unknown';
  }
}

/**
 * Runs the read-only runtime probes of the entries against one RPC endpoint. A registry entry records how the
 * reference RPC behaves; a provider may differ, and only asking it tells. A probe is data: the calls to make,
 * what to record and when the endpoint passes. Nothing is written, nothing is signed, no key is involved.
 */
export async function probeRpc(
  rpcUrl: string,
  entries: Entry[],
  rpc: Rpc = httpRpc(rpcUrl),
): Promise<RpcProbeReport> {
  const endpoint = redactUrl(rpcUrl);
  const probes: ProbeResult[] = [];
  let chain: string;
  try {
    chain = await identifyEndpoint(rpc);
  } catch (error) {
    const explanation = `The endpoint did not answer: ${reason(error, rpcUrl)}`;
    return {
      endpoint,
      chain: 'unknown',
      observed: 0,
      probes: [
        { entry: '-', rule: '-', fixture: '-', expect: '-', verdict: 'unreachable', explanation, calls: [] },
      ],
    };
  }
  const name = chainNameOf(chain);

  for (const entry of entries) {
    for (const rule of entry.detect) {
      if (rule.kind !== 'runtime-probe') continue;
      const probe = probeOf(rule.probe);
      const fixture = rule.probe.fixture ?? '';
      const base = { entry: entry.id, rule: rule.rule, fixture, expect: rule.probe.expect };
      // A probe only ever reads, whatever the entry says: a method outside the read-only list is never called.
      const unsafe = probe?.calls.find((call) => !(PROBE_METHODS as readonly string[]).includes(call.method));
      if (unsafe !== undefined) {
        probes.push({
          ...base,
          verdict: 'not-applicable',
          explanation: `This tool does not call ${unsafe.method}: a probe may only read.`,
          calls: [],
        });
        continue;
      }
      if (probe === undefined) {
        probes.push({
          ...base,
          verdict: 'not-applicable',
          explanation: `This tool cannot run a probe of ${'method' in rule.probe ? rule.probe.method : 'this form'}.`,
          calls: [],
        });
        continue;
      }
      // <chain>:<id>: a cluster name (schema 1) or a CAIP-2 id with a colon of its own (schema 2) — the id is what
      // follows the last colon.
      const split = probe.fixture.lastIndexOf(':');
      const fixtureChain = probe.fixture.slice(0, split);
      const id = probe.fixture.slice(split + 1);
      const fixtureCaip =
        fixtureChain in SOLANA_CHAINS
          ? SOLANA_CHAINS[fixtureChain as keyof typeof SOLANA_CHAINS]
          : fixtureChain;
      if (fixtureCaip !== chain) {
        probes.push({
          ...base,
          verdict: 'not-applicable',
          explanation: `The fixture lives on ${fixtureCaip}, the endpoint serves ${chain}.`,
          calls: [],
        });
        continue;
      }
      const calls: ProbeCall[] = [];
      const answers = new Map<string, Awaited<ReturnType<Rpc>>>();
      try {
        for (const step of probe.calls) {
          const params = step.params.map((param) => (param === '$fixture' ? id : param));
          const answer = await rpc(step.method, params);
          answers.set(step.id, answer);
          if (answer.error !== undefined)
            calls.push({
              call: step.id,
              method: step.method,
              outcome: { ok: false, code: answer.error.code ?? null, message: answer.error.message ?? '' },
            });
          else if (answer.result === null || answer.result === undefined)
            calls.push({
              call: step.id,
              method: step.method,
              outcome: { ok: false, code: null, message: 'transaction not found on this endpoint' },
            });
          else
            calls.push({
              call: step.id,
              method: step.method,
              outcome: {
                ok: true,
                observed: Object.fromEntries(
                  probe.observe
                    .filter((path) => path.startsWith('result'))
                    .map((path) => [path, recordable(at(answer, path))]),
                ),
              },
            });
        }
      } catch (error) {
        probes.push({
          ...base,
          verdict: 'unreachable',
          explanation: `The endpoint stopped answering: ${reason(error, rpcUrl)}`,
          calls,
        });
        continue;
      }
      // Missing means no answer had the transaction and none was an error: an error without a code is still a
      // refusal, not a pruned history.
      const missing = [...answers.values()].every(
        (answer) => answer.error === undefined && (answer.result === null || answer.result === undefined),
      );
      const failed = probe.pass.filter(
        (condition) => at(answers.get(condition.call), condition.path) !== condition.equals,
      );
      probes.push({
        ...base,
        verdict: missing ? 'fixture-missing' : failed.length === 0 ? 'reads' : 'cannot-read',
        explanation: missing
          ? 'The endpoint does not have the fixture transaction (pruned history?), so its behaviour could not be observed.'
          : failed.length === 0
            ? `The endpoint answers as the entry expects: ${probe.pass.map((c) => `${c.call} ${c.path} = ${JSON.stringify(c.equals)}`).join('; ')}.`
            : `The endpoint does not: ${failed.map((c) => `${c.call} ${c.path} is ${JSON.stringify(recordable(at(answers.get(c.call), c.path)))}, not ${JSON.stringify(c.equals)}`).join('; ')}.`,
        calls,
      });
    }
  }
  const observed = probes.filter(
    (probe) => probe.verdict === 'reads' || probe.verdict === 'cannot-read',
  ).length;
  return { endpoint, chain, ...(name === undefined ? {} : { name }), observed, probes };
}
