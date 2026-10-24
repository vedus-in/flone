'use client';

import { useEffect } from 'react';

/**
 * True when a keystroke should be left to whatever has focus: a text field, a
 * select, something editable, or an open menu/dialog/listbox.
 */
export function keyBelongsElsewhere(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  }
  return Boolean(document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]'));
}

/**
 * Runs `handler` when the single-letter `key` is pressed anywhere on the page
 * and nothing else claims it. Pass `null` to bind nothing.
 */
export function useHotkey(key: string | null | undefined, handler: () => void): void {
  useEffect(() => {
    if (!key) return;
    const wanted = key.toLowerCase();
    function onKeyDown(event: KeyboardEvent) {
      if (event.shiftKey || event.key.toLowerCase() !== wanted || keyBelongsElsewhere(event)) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, handler]);
}
