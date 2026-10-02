import { type ActivationReader, type ChainReading, readActivations } from './activation-status.js';
import { validatePath } from './load.js';
import type { Issue } from './validate.js';

export type StatusReport =
  | ({ ok: true } & ChainReading)
  | { ok: false; kind: 'registry'; issues: Issue[] }
  | { ok: false; kind: 'network'; chain: string; error: string };

/**
 * The state, on one chain, of every activation named by the entries under `registryPath`. An unreachable or
 * mistaken endpoint is a result, not an exception: the command has to say so, not crash.
 */
export async function registryStatus(
  registryPath: string,
  reader: ActivationReader,
  asked?: string,
): Promise<StatusReport> {
  const registry = validatePath(registryPath);
  if (!registry.ok) {
    const issues = registry.files.flatMap((file) =>
      file.issues.map((issue) => ({ ...issue, path: `${file.file}: ${issue.path}` })),
    );
    return { ok: false, kind: 'registry', issues: [...issues, ...registry.registryIssues] };
  }
  const entries = registry.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry]));
  try {
    return { ok: true, ...(await readActivations(entries, reader, asked)) };
  } catch (error) {
    return {
      ok: false,
      kind: 'network',
      chain: asked ?? 'behind that endpoint',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
