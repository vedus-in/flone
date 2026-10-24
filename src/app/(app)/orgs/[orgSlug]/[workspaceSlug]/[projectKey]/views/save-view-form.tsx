import { ActionForm } from '../../../../../action-form';
import { createSavedView } from '../actions';

/**
 * "Save this filter as a view."
 *
 * A `<details>` rather than a dialog: it is one text field, it only appears once
 * a filter is actually set, and collapsing it is what the element already does
 * without a line of JavaScript.
 *
 * The view stores the query string it was saved from, so replaying it is a plain
 * link and there is no second filter language to keep in sync.
 */
export function SaveViewForm({ projectId, query }: { projectId: string; query: string }) {
  return (
    <details className="group relative w-fit">
      <summary className="h-6 w-fit cursor-pointer list-none rounded-md px-2 text-xs leading-6 text-tertiary transition-colors hover:bg-secondary hover:text-primary">
        Save as view
      </summary>
      <div className="absolute start-0 top-7 z-30 w-max rounded-lg border border-secondary_alt bg-elevated p-2 shadow-lg">
        <ActionForm
          action={createSavedView}
          className="flex flex-wrap items-center gap-2"
          aria-label="Save this view"
          resetOnSuccess
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="query" value={query} />
          <input
            name="name"
            required
            maxLength={60}
            autoComplete="off"
            placeholder="View name"
            aria-label="View name"
            className="h-7 rounded-md border border-primary bg-secondary_subtle px-2.5 text-sm text-primary placeholder:text-placeholder focus:border-brand focus:outline-none"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-tertiary">
            <input
              type="checkbox"
              name="isShared"
              defaultChecked
              className="size-3.5 accent-brand-600"
            />
            Share with the team
          </label>
          <button
            type="submit"
            className="h-7 rounded-md bg-brand-solid px-3 text-sm font-medium text-white transition-colors hover:bg-brand-solid_hover"
          >
            Save
          </button>
        </ActionForm>
      </div>
    </details>
  );
}
