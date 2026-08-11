/**
 * The whole client layer.
 *
 * Flone's MCP endpoint is a stateless JSON-RPC surface covering organizations,
 * projects, boards, issues, comments and administration — everything the web UI
 * can do. So the CLI is not a second API client with its own opinions: it is a
 * thin caller of tools that already exist, and every command below is exactly
 * one `tools/call`.
 *
 * Nothing here imports from the app. This is an ordinary HTTP client and points
 * wherever the config says.
 */

/** A message written by us or by the server, safe to print verbatim. */
export class CliError extends Error {}

/** Printed with the fix attached: the token is missing, expired or revoked. */
export class AuthError extends CliError {}

export type Call = <T = unknown>(tool: string, args?: Record<string, unknown>) => Promise<T>;

type RpcResponse = {
  error?: { message?: string };
  result?: {
    isError?: boolean;
    content?: { type?: string; text?: string }[];
  };
};

export function client(host: string, token: string): Call {
  let nextId = 0;

  return async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const endpoint = `${host}/api/mcp`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: (nextId += 1),
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      });
    } catch (e) {
      // DNS failure, connection refused, TLS mismatch — the host is the useful
      // half of the message, since the usual cause is pointing at the wrong one.
      throw new CliError(`Could not reach ${host} (${(e as Error).message}).`);
    }

    // The endpoint answers 401 for a bad credential and 200 for a failed tool,
    // so this is the only status that means "your token is the problem".
    if (response.status === 401) {
      throw new AuthError('Not signed in, or your token was revoked. Run `flone login`.');
    }

    if (!response.ok) {
      throw new CliError(`${host} answered ${response.status} ${response.statusText}.`);
    }

    let body: RpcResponse;
    try {
      body = (await response.json()) as RpcResponse;
    } catch {
      throw new CliError(`${host} did not return JSON. Is that a Flone server?`);
    }

    // A protocol error (unknown tool, bad params) rather than a failed call.
    if (body.error) throw new CliError(body.error.message ?? 'The server rejected that request.');

    const text = body.result?.content?.[0]?.text ?? '';

    // Per the MCP spec a tool that fails is a RESULT carrying `isError`, not a
    // JSON-RPC error — and the text is a plain sentence, not JSON. These
    // messages are written to be shown to people, so they are printed as-is.
    if (body.result?.isError) {
      throw new CliError(text === '' ? 'The server rejected that request.' : text);
    }

    if (text === '') return {} as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError('The server returned a malformed tool result.');
    }
  };
}
