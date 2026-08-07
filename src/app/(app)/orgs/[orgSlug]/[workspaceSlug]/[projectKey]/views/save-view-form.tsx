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
    <details className="group w-fit">
      <summary className="w-fit cursor-pointer list-none rounded-lg border border-secondary px-2.5 py-1 text-[0.8125rem] text-tertiary transition-colors hover:bg-secondary hover:text-primary">
        Save as view
      </summary>
      <div className="pt-2">
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
            className="h-8 rounded-lg border border-secondary bg-primary px-2.5 text-[0.8125rem] text-primary placeholder:text-tertiary focus:outline-2 focus:outline-offset-1 focus:outline-focus-ring"
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
            className="h-8 rounded-lg bg-brand-solid px-2.5 text-[0.8125rem] font-medium text-white transition-opacity hover:opacity-90"
          >
            Save
          </button>
        </ActionForm>
      </div>
    </details>
  );
}
