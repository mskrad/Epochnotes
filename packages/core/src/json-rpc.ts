import { redactUrl } from './onchain.js';

/** One JSON-RPC call. Readers take this function, so tests substitute it without a network. */
export type JsonRpc = (
  method: string,
  params: unknown[],
) => Promise<{ result?: unknown; error?: { code?: number; message?: string } }>;

/** A public endpoint that does not answer must not hang a command. */
const TIMEOUT_MS = 20_000;

/** JSON-RPC over HTTP. Transport errors keep their reason and drop the URL, which may carry a key. */
export function httpJsonRpc(rpcUrl: string): JsonRpc {
  return async (method, params) => {
    let response: Response;
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${redactUrl(rpcUrl)} did not answer ${method}: ${reason.split(rpcUrl).join('<endpoint>')}`,
      );
    }
    if (!response.ok) throw new Error(`${redactUrl(rpcUrl)} answered ${method} with HTTP ${response.status}`);
    return (await response.json()) as Awaited<ReturnType<JsonRpc>>;
  };
}

/** The result of a call, or an error that names the method and what the endpoint said. */
export async function call(rpc: JsonRpc, method: string, params: unknown[] = []): Promise<unknown> {
  const answer = await rpc(method, params);
  if (answer.error !== undefined)
    throw new Error(
      `${method} failed: ${answer.error.message ?? 'no message'} (code ${answer.error.code ?? '-'})`,
    );
  return answer.result;
}
