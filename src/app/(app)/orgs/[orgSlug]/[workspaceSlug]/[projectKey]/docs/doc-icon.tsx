/**
 * The page glyph every docs surface draws -- the same path the sidebar's
 * Documents row uses, so a document looks like the same thing everywhere it
 * appears. Server-safe: no hooks, no handlers, no 'use client'.
 */
export function DocIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 11h4" />
    </svg>
  );
}
