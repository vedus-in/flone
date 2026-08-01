import { ButtonLink, EmptyState } from '@/components/ui';

/**
 * Serves both "this does not exist" and "this is not yours" -- `loadPage` maps
 * NOT_FOUND and FORBIDDEN to the same `notFound()`, so the two are
 * indistinguishable at the HTTP level and this copy must stay indistinguishable
 * too. It deliberately says nothing about which of the two occurred.
 */
export default function NotFound() {
  return (
    <main className="auth-shell">
      <div className="container container-narrow">
        <EmptyState
          title="Not found."
          description="That page doesn't exist, or you don't have access to it."
        >
          <ButtonLink href="/">Back to your boards</ButtonLink>
        </EmptyState>
      </div>
    </main>
  );
}
