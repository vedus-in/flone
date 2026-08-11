import { CliError, type Call } from './mcp.js';

/**
 * The shapes the tools return, and the lookups every command shares.
 *
 * These types are hand-written rather than imported from the app: the CLI ships
 * as its own npm package and must not drag a Next.js server into anyone's
 * global install. The tool results are a wire contract, so the duplication is
 * the same kind any HTTP client accepts.
 */

export type Me = { userId: string; name: string; email: string };

export type NavProject = { id: string; key: string; name: string };
export type NavOrg = {
  id: string;
  name: string;
  slug: string;
  role: string;
  workspaces: { id: string; name: string; slug: string; projects: NavProject[] }[];
};

export type State = { stateId: string; name: string; type: string };

export type Project = {
  project: string;
  projectKey: string;
  organization: string;
  orgSlug: string;
  yourRole: string;
  states: State[];
  labels: { labelId: string; name: string; color: string }[];
  boards: { boardId: string; name: string; status: string; tickets: number }[];
  currentCycle: number | null;
};

export type Card = {
  ticketId: string;
  ref: string;
  title: string;
  priority: string | null;
  dueDate: string | null;
  assignee: string | null;
  labels: string[];
  comments: number;
  updatedAt: string;
};

export type Board = {
  board: string;
  boardId: string;
  project: string;
  projectKey: string;
  orgSlug: string;
  columns: { name: string; stateId: string; type: string; tickets: Card[] }[];
  members: { userId: string; name: string; email: string; role: string }[];
};

export type Found = Card & {
  status: string;
  statusType: string;
  board: string | null;
  boardId: string | null;
  project: string;
  cycle: number | null;
};

/**
 * `get_ticket` is the one read whose shape differs from the list views:
 * `assignee` is an object rather than a name, and `cycle` is already rendered
 * as a label. Both are reproduced here as they arrive, not as the lists have
 * them — a type that flatters the data is how a `null` reaches `.name`.
 */
export type Ticket = {
  ticketId: string;
  ref: string;
  title: string;
  description: string | null;
  status: string;
  statusType: string;
  priority: string | null;
  dueDate: string | null;
  assignee: { id: string; name: string; email: string } | null;
  labels: string[];
  board: string | null;
  cycle: string | null;
  parent: { ticketId: string; ref: string; title: string } | null;
  subIssues: { ticketId: string; ref: string; title: string; status: string }[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  comments: { commentId: string; author: string; body: string; createdAt: string }[];
};

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which project a command acts on, when it was not told.
 *
 * The chain is explicit flag → configured default → the only one you have. It
 * stops rather than guessing between several, because picking a project for
 * someone is how an issue gets filed in the wrong team.
 */
export async function resolveProject(
  call: Call,
  wanted: string | undefined,
  fallback: string | undefined,
): Promise<{ orgSlug: string; projectKey: string }> {
  const { organizations } = await call<{ organizations: NavOrg[] }>('list_boards');

  const all = organizations.flatMap((org) =>
    org.workspaces.flatMap((workspace) =>
      workspace.projects.map((project) => ({ orgSlug: org.slug, projectKey: project.key })),
    ),
  );

  if (all.length === 0) {
    throw new CliError('You are not a member of any project yet. Create one with `flone project new`.');
  }

  const asked = wanted ?? fallback;

  if (asked) {
    const key = asked.toUpperCase();
    const matches = all.filter((entry) => entry.projectKey === key);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new CliError(`No project ${key}. You have: ${all.map((e) => e.projectKey).join(', ')}.`);
    }
    throw new CliError(
      `${key} exists in more than one organization. Pass --org ${matches
        .map((e) => e.orgSlug)
        .join(' or --org ')}.`,
    );
  }

  if (all.length === 1) return all[0]!;

  throw new CliError(
    `Which project? Pass --project, or set a default with \`flone use <KEY>\`. You have: ${all
      .map((entry) => entry.projectKey)
      .join(', ')}.`,
  );
}

/** A board within an already-resolved project: by name, by id, or the only one. */
export function resolveBoard(project: Project, wanted: string | undefined): string {
  if (project.boards.length === 0) {
    throw new CliError(`${project.projectKey} has no boards. Create one with \`flone board new\`.`);
  }

  if (!wanted) {
    if (project.boards.length === 1) return project.boards[0]!.boardId;
    throw new CliError(
      `Which board? Pass --board. ${project.projectKey} has: ${project.boards
        .map((board) => board.name)
        .join(', ')}.`,
    );
  }

  const needle = wanted.toLowerCase();
  const match = project.boards.find(
    (board) => board.name.toLowerCase() === needle || board.boardId === wanted,
  );
  if (!match) {
    throw new CliError(
      `No board "${wanted}" in ${project.projectKey}. It has: ${project.boards
        .map((board) => board.name)
        .join(', ')}.`,
    );
  }
  return match.boardId;
}
