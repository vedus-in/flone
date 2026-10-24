/**
 * Light / dark / system appearance, stored per browser.
 *
 * Kept in `localStorage` rather than on the account: it is a property of the
 * screen someone is looking at, and reading it before first paint (the inline
 * script in `src/app/layout.tsx`) is only possible from something synchronous
 * in the page. A cookie would work too, but would make every route dynamic for
 * the sake of a class name.
 *
 * Dark is the default, as it always was here.
 */

export type ThemePreference = 'dark' | 'light' | 'system';

export const THEME_STORAGE_KEY = 'flone-theme';

const THEME_EVENT = 'flone:theme';

function isPreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : 'dark';
  } catch {
    // Storage blocked (private mode, a sandboxed frame): fall back to the default.
    return 'dark';
  }
}

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyThemePreference(preference: ThemePreference): void {
  const dark = preference === 'dark' || (preference === 'system' && prefersDark());
  document.documentElement.classList.toggle('dark-mode', dark);
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not persisted, but the switch below still applies for this page view.
  }
  applyThemePreference(preference);
  window.dispatchEvent(new CustomEvent<ThemePreference>(THEME_EVENT, { detail: preference }));
}

/** Calls `listener` whenever the preference changes in this tab. */
export function onThemePreferenceChange(listener: (preference: ThemePreference) => void): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isPreference(detail)) listener(detail);
  };
  window.addEventListener(THEME_EVENT, handle);
  return () => window.removeEventListener(THEME_EVENT, handle);
}

/**
 * Runs before React, from a `<script>` in the document head, so the first paint
 * is already in the right appearance. Kept as a string because it must not
 * depend on a bundle having loaded. Mirrors `readThemePreference` +
 * `applyThemePreference`.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');var d=p==='light'?false:p==='system'?window.matchMedia('(prefers-color-scheme: dark)').matches:true;document.documentElement.classList.toggle('dark-mode',d);}catch(e){}})();`;
