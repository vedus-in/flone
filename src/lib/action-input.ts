import 'server-only';
import type { z } from 'zod';

/**
 * The three lines every Server Action file used to repeat verbatim.
 *
 * Extracted because the Linear rework roughly quadrupled the number of action
 * files, and four copies of a FormData reader is four chances for one of them
 * to start treating a `File` as a string.
 */

/** The one closed literal an action may return for a validation failure. */
export const INVALID_INPUT = 'Please check the form and try again.';

/** FormData values are `string | File | null`; every action here wants a string. */
export function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/** Present-and-non-blank, or undefined so a zod `.optional()` can see it. */
export function optionalField(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Every value under a repeated form key, e.g. a multi-select of label ids. */
export function fieldList(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((value): value is string => typeof value === 'string');
}

/** First message per field. Every message originates in our own schemas. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}
