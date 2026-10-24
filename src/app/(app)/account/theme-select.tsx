'use client';

import { useEffect, useState } from 'react';

import {
  onThemePreferenceChange,
  readThemePreference,
  setThemePreference,
  type ThemePreference,
} from '@/lib/theme';
import { cx } from '@/lib/utils/cx';

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Light / dark / system, as a segmented control. Per browser, not per account
 * -- see `src/lib/theme.ts` -- so it saves instantly with no server round trip.
 */
export function ThemeSelect() {
  // `null` until mounted: the server cannot know what this browser stored.
  const [value, setValue] = useState<ThemePreference | null>(null);

  useEffect(() => {
    setValue(readThemePreference());
    return onThemePreferenceChange(setValue);
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label="Interface theme"
      className="inline-flex rounded-lg border border-secondary bg-tertiary p-0.5"
    >
      {OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setThemePreference(option.value)}
            className={cx(
              'h-7 rounded-md px-3 text-sm font-medium transition-colors outline-focus-ring focus-visible:outline-2',
              selected ? 'bg-quaternary text-primary shadow-xs' : 'text-tertiary hover:text-primary',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
