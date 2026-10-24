'use client';

import { useEffect } from 'react';

/** True when focus is in a text field, a select, or anything editable. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * True when a menu, dialog or popup list owns the keyboard. Judged by where
 * focus is rather than by what is in the DOM: every one of those moves focus
 * inside itself when it opens, and a list that merely sits on the page does not.
 */
export function overlayHasFocus(): boolean {
  const active = document.activeElement;
  return active instanceof Element && active.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

/** True when a keystroke should be left to whatever has focus. */
export function keyBelongsElsewhere(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return true;
  return isTypingTarget(event.target) || overlayHasFocus();
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
