import { ButtonLink } from '@/components/ui';

/**
 * Serves both "this does not exist" and "this is not yours" -- `loadPage` maps
 * NOT_FOUND and FORBIDDEN to the same `notFound()`, so the two are
 * indistinguishable at the HTTP level and this copy must stay indistinguishable
 * too. It deliberately says nothing about which of the two occurred, and the
 * mark above it is the neutral brand glyph rather than anything alarming.
 *
 * This is the root not-found boundary, so it renders inside the root layout with
 * no app header or auth shell around it -- hence the full-viewport centering
 * here rather than a page-level wrapper.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-center gap-7 text-center">
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"
        >
          <svg viewBox="0 0 32 32" fill="currentColor" className="size-5">
            <rect x="3" y="5" width="6" height="22" rx="2" />
            <rect x="13" y="5" width="6" height="16" rx="2" />
            <rect x="23" y="5" width="6" height="11" rx="2" />
          </svg>
        </span>

        <div className="flex flex-col items-center gap-2">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted tabular-nums">
            Error 404
          </p>
          <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
            This page isn’t here
          </h1>
          <p className="max-w-[44ch] text-pretty text-sm leading-relaxed text-muted">
            That page doesn’t exist, or you don’t have access to it.
          </p>
        </div>

        <ButtonLink href="/" variant="primary">
          Back to your boards
        </ButtonLink>
      </div>
    </main>
  );
}
