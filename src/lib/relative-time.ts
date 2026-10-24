/**
 * "5mo ago", "3d ago", "just now" -- the compact age Linear prints beside every
 * activity entry. Computed on the server against one `now`, so the string a
 * page renders is fixed for that render and hydration has nothing to disagree
 * about.
 */
export function relativeTime(value: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - value.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  // Twelve 30-day months is 360 days, five short of a year: never print 0y.
  return `${Math.max(1, Math.floor(days / 365))}y ago`;
}
