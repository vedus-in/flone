'use client';

/**
 * Create a token, then hand over snippets that already contain it.
 *
 * The create form and the snippets share one `useActionState`, which is the
 * whole reason this is a single client component rather than `ActionForm` plus
 * server-rendered `<pre>`s: the raw token exists for exactly one render, and the
 * snippets have to be able to read it. Nothing is stored -- reload the page and
 * the placeholder is back, same as before.
 */

import { useActionState, useEffect, useRef, useState } from 'react';
import { Check, Copy01 } from '@untitledui/icons';

import { SubmitButton } from '@/components/submit-button';
import type { ActionResult } from '@/lib/result';
import { cx } from '@/lib/utils/cx';

import { createMcpToken } from './actions';

const PLACEHOLDER = '<your-token>';

/**
 * `Card` is copied here as a class string rather than imported: `@/components/ui`
 * re-exports react-markdown and every other primitive, and importing it from a
 * client module drags all of that into this bundle. Same reasoning as the
 * hand-rolled banners in `../action-form.tsx`.
 */
const CARD = 'flex flex-col gap-4 rounded-xl bg-primary p-6 shadow-xs ring-1 ring-secondary';

type CopyState = 'idle' | 'copied' | 'error';

function useCopy() {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(text: string) {
    let next: CopyState = 'copied';
    try {
      // Undefined on an insecure origin, and can reject when the document is not
      // focused -- either way the user still has the text on screen to select.
      await navigator.clipboard.writeText(text);
    } catch {
      next = 'error';
    }
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }

  return [state, copy] as const;
}

/**
 * A snippet that copies itself. The whole block is the hit target because that
 * is what people try first; the button is what keyboards and screen readers get,
 * and it carries the confirmation as text rather than only as a colour change.
 */
function CopyBlock({
  text,
  label,
  wrap = false,
}: {
  text: string;
  label: string;
  /** For a single unbroken string (a token): wrap it instead of scrolling it. */
  wrap?: boolean;
}) {
  const [state, copy] = useCopy();

  return (
    <div
      onClick={() => void copy(text)}
      className={cx(
        'relative cursor-pointer rounded-lg bg-secondary ring-1 transition duration-150',
        state === 'copied' ? 'ring-brand' : 'ring-transparent hover:ring-secondary',
      )}
    >
      <pre
        className={cx(
          'p-4 pe-24 text-xs',
          wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto',
        )}
      >
        <code>{text}</code>
      </pre>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void copy(text);
        }}
        aria-label={`Copy ${label}`}
        className="absolute end-2 top-2 flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-xs font-medium text-secondary outline-focus-ring ring-1 ring-secondary transition duration-150 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {state === 'copied' ? (
          <Check className="size-3.5 text-success-primary" aria-hidden="true" />
        ) : (
          <Copy01 className="size-3.5" aria-hidden="true" />
        )}
        <span role="status">
          {state === 'copied' ? 'Copied' : state === 'error' ? 'Select and copy' : 'Copy'}
        </span>
      </button>
    </div>
  );
}

export function McpSetup({ endpoint }: { endpoint: string }) {
  const [result, formAction] = useActionState<ActionResult | null, FormData>(
    createMcpToken,
    null,
  );
  const token = result?.ok ? result.message : undefined;
  const secret = token ?? PLACEHOLDER;

  // One line, no backslash continuation: `\` is not a line continuation in
  // PowerShell or cmd, so the wrapped form only ever worked in a POSIX shell.
  const command = `claude mcp add --transport http flone ${endpoint} --header "Authorization: Bearer ${secret}"`;

  const config = `{
  "mcpServers": {
    "flone": {
      "type": "http",
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer ${secret}" }
    }
  }
}`;

  return (
    <>
      <section aria-labelledby="create-heading">
        <div className={CARD}>
          <div className="flex flex-col gap-1">
            <h2 id="create-heading" className="text-base font-semibold text-primary">
              Create a token
            </h2>
            <p className="text-sm text-tertiary">
              A token has the same access as signing in: every organization you belong to, and
              everything you can do there. It is shown once, right here, and never again.
            </p>
          </div>

          <form action={formAction} aria-label="Create an MCP token">
            <SubmitButton pendingLabel="Creating...">
              {token ? 'Create another token' : 'Create token'}
            </SubmitButton>
          </form>

          {result && !result.ok ? (
            <p
              role="alert"
              className="rounded-lg bg-error-primary px-3 py-2 text-sm text-error-primary"
            >
              {result.error}
            </p>
          ) : null}

          {token ? (
            <div className="flex flex-col gap-2 rounded-xl bg-secondary p-4 ring-1 ring-brand">
              <p className="text-sm font-medium text-primary">
                Here is your token. Copy it now — closing this page loses it.
              </p>
              <CopyBlock text={token} label="your token" wrap />
              <p className="text-xs text-tertiary">
                You do not have to. Both snippets below already have this token filled in, so
                you can copy one and paste it straight into your client.
              </p>
            </div>
          ) : null}

          <p className="max-w-prose text-xs text-tertiary">
            It expires 30 days after its last use, and stays alive as long as it keeps being
            used. Revoke it below at any time.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="connect-heading">
        <h2 id="connect-heading" className="text-sm font-medium text-primary">
          Connect a client
        </h2>

        <div className={CARD}>
          <p className="text-sm text-tertiary">
            One command in Claude Code
            {token ? ', with your token already in it' : ''} — click it to copy:
          </p>
          <CopyBlock text={command} label="the Claude Code command" />

          <p className="text-sm text-tertiary">Or, for any client that reads a config file:</p>
          <CopyBlock text={config} label="the config snippet" />

          {token ? null : (
            <p className="text-xs text-tertiary">
              Create a token above and both snippets fill themselves in — no{' '}
              <code>{PLACEHOLDER}</code> left to replace by hand.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

export default McpSetup;
