'use client';

/**
 * Carries the browser's UTC offset into the create-reminder action.
 *
 * A `<input type="datetime-local">` submits a wall clock with no zone -- "09:00"
 * and nothing more -- so without this the server would have to guess, and would
 * guess wrong for everyone not sitting in its own timezone. `getTimezoneOffset()`
 * is the whole answer and needs no timezone database on either side.
 *
 * Written to `defaultValue` rather than `value` deliberately: that sets the
 * `value` ATTRIBUTE, so the offset survives the form reset React 19 performs
 * when an action settles. Setting the property alone would leave a rejected
 * submit re-sending the "0" the server rendered, and the reminder would land an
 * hour or several out.
 *
 * Server-rendered as 0, which the schema also falls back to. A visitor with no
 * JavaScript gets UTC rather than a broken form.
 */
export function TzOffsetField() {
  return (
    <input
      type="hidden"
      name="tzOffsetMinutes"
      defaultValue="0"
      ref={(node) => {
        if (node) node.defaultValue = String(new Date().getTimezoneOffset());
      }}
    />
  );
}
