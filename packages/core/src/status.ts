import { type FeatureAccountSource, type FeatureState, readFeatureStatus } from './feature-status.js';
import { validatePath } from './load.js';
import type { Issue } from './validate.js';

export interface GateStatus {
  entry: string;
  rev: number;
  subject: string;
  label: string;
  address: string;
  status: FeatureState;
}

export type StatusReport =
  | { ok: true; cluster: string; slot: bigint; gates: GateStatus[]; withoutGates: string[] }
  | { ok: false; kind: 'registry'; issues: Issue[] }
  | { ok: false; kind: 'network'; cluster: string; error: string };

/** Activation state of every feature gate named by the entries under `registryPath`, on one cluster. */
export async function registryStatus(
  registryPath: string,
  cluster: string,
  source: FeatureAccountSource,
): Promise<StatusReport> {
  const registry = validatePath(registryPath);
  if (!registry.ok) {
    const issues = registry.files.flatMap((file) =>
      file.issues.map((issue) => ({ ...issue, path: `${file.file}: ${issue.path}` })),
    );
    return { ok: false, kind: 'registry', issues: [...issues, ...registry.registryIssues] };
  }
  const entries = registry.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry]));
  const gates = entries.flatMap((entry) =>
    (entry.applies.gates ?? []).map((gate) => ({
      entry: entry.id,
      rev: entry.rev,
      subject: entry.subject.name,
      label: gate.label,
      address: gate.address,
    })),
  );
  const network = await readFeatureStatus(
    source,
    gates.map((gate) => gate.address),
  );
  if (!network.ok) return { ok: false, kind: 'network', cluster, error: network.error };
  return {
    ok: true,
    cluster,
    slot: network.slot,
    gates: gates.map((gate) => ({
      ...gate,
      status: network.states.get(gate.address) ?? { state: 'absent' },
    })),
    withoutGates: entries.filter((entry) => entry.applies.gates === undefined).map((entry) => entry.id),
  };
}
