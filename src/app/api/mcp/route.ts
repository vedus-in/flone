import { randomUUID } from 'node:crypto';

import { AuthzError, isNextControlFlowError } from '@/lib/authz';
import { TOOLS_BY_NAME, ToolError, toolDescriptors } from '@/lib/mcp';
import { ERRORS } from '@/lib/result';
import { readSession } from '@/lib/session';

/**
 * Model Context Protocol endpoint — Streamable HTTP transport, stateless.
 *
 * Stateless is the whole trick: with no server-initiated messages there is
 * nothing to stream, so every request is one JSON-RPC message in and one JSON
 * object out. That is a conformant subset of the transport (the spec lets a
 * server answer a request with `application/json` instead of an SSE stream, and
 * lets it assign no session id), and it means no long-lived connection, no
 * session table, and no reason to pull in an SDK whose transport wants raw Node
 * `req`/`res` objects this runtime does not hand out.
 *
 * Authentication is the ordinary app session presented as
 * `Authorization: Bearer <token>`; see `presentedToken()` in `@/lib/session`.
 * The tools themselves re-derive the session and re-walk to the organization,
 * so the check here is only how a bad token becomes a clean 401 instead of a
 * tool error.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Answered as-is when the client asks for one of these; otherwise the newest. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const SERVER_INFO = {
  name: 'flone',
  title: 'Flone',
  version: '0.1.0',
};

const INSTRUCTIONS =
  'Boards, tickets, comments, reminders, saved views and the Daily Challenges board for the ' +
  'signed-in user. Call list_boards first to get ids, then get_board or search_tickets. ' +
  'Ticket ids are opaque: never invent one, though a ref like ENG-12 is accepted anywhere ' +
  'a ticketId is. Every call acts as the person who issued the token and is limited to ' +
  'their organizations.';

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown, status = 200): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { status, headers: NO_STORE });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: NO_STORE });
}

const NO_STORE = { 'Cache-Control': 'no-store' };

/** A tool that failed is a RESULT with isError, not a protocol error (MCP spec). */
function toolFailure(id: JsonRpcId, message: string): Response {
  return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

export async function POST(request: Request): Promise<Response> {
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }

  const { id, method, params } = message as {
    id?: JsonRpcId;
    method?: unknown;
    params?: unknown;
  };

  // Fire-and-forget: a RESPONSE carries no method, a NOTIFICATION carries no id
  // (`notifications/initialized` and `notifications/cancelled` are the ones a
  // client actually sends). Both are acknowledged with an empty 202 — answering
  // either of them would be a protocol violation, so this must sit ahead of the
  // authentication check.
  if (typeof method !== 'string' || id === undefined || id === null) {
    return new Response(null, { status: 202, headers: NO_STORE });
  }

  // The session is the credential. 401 (not a JSON-RPC error) so the client
  // reports "not connected" rather than "tool failed".
  const session = await readSession();
  if (!session) {
    return Response.json(
      { jsonrpc: '2.0', id, error: { code: -32001, message: ERRORS.UNAUTHENTICATED } },
      {
        status: 401,
        headers: { ...NO_STORE, 'WWW-Authenticate': 'Bearer realm="flone"' },
      },
    );
  }

  const args = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'initialize': {
      const asked = (args as { protocolVersion?: unknown }).protocolVersion;
      return rpcResult(id, {
        protocolVersion:
          typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: toolDescriptors() });

    case 'tools/call': {
      const name = (args as { name?: unknown }).name;
      const tool = typeof name === 'string' ? TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);

      const toolArgs = ((args as { arguments?: unknown }).arguments ?? {}) as Record<
        string,
        unknown
      >;

      try {
        const output = await tool.run(toolArgs);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        });
      } catch (e) {
        if (isNextControlFlowError(e)) throw e;

        // A message we wrote ourselves: safe to hand back.
        if (e instanceof ToolError) return toolFailure(id, e.message);

        if (e instanceof AuthzError) {
          if (e.kind === 'UNAUTHENTICATED') return toolFailure(id, ERRORS.UNAUTHENTICATED);
          // NOT_FOUND and FORBIDDEN read identically, exactly as they do over
          // HTTP: there is no existence oracle here either.
          return toolFailure(id, e.kind === 'FORBIDDEN' ? ERRORS.FORBIDDEN : ERRORS.NOT_FOUND);
        }

        // Never `e.message` — a short code plus a correlation id (SPEC §4.7).
        const ref = randomUUID().slice(0, 8);
        console.error(`[mcp] unexpected_failure tool=${tool.name} ref=${ref}`);
        return toolFailure(id, ERRORS.UNEXPECTED);
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * No server-initiated stream and no sessions to terminate, so the spec's answer
 * to both is the same one.
 */
export function GET(): Response {
  return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: 'POST' } });
}

export const DELETE = GET;
