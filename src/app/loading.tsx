/**
 * The app-wide navigation fallback.
 *
 * Deliberately weightless: a few dashed blocks reusing the `.placeholder`
 * treatment already defined in `globals.css`, so the skeleton speaks the same
 * visual language as the empty states it briefly stands in for. No animation
 * (nothing to respect `prefers-reduced-motion` about), no new CSS.
 *
 * Each block holds a `&nbsp;` so it keeps a line box -- a plain space would be
 * collapsed and the block would render shorter than the card it stands in for.
 *
 * The blocks are `aria-hidden`; the single polite status line is what assistive
 * technology announces.
 */
export default function Loading() {
  return (
    <main className="main" aria-busy="true">
      <div className="container stack">
        <p role="status" className="visually-hidden">
          Loading…
        </p>

        <div className="placeholder" aria-hidden="true">
          &nbsp;
        </div>

        <div className="grid" aria-hidden="true">
          <div className="placeholder">&nbsp;</div>
          <div className="placeholder">&nbsp;</div>
          <div className="placeholder">&nbsp;</div>
        </div>
      </div>
    </main>
  );
}
