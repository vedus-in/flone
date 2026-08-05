import 'server-only';

import { Priority } from '@prisma/client';

import {
  AuthzError,
  boardPath,
  isNextControlFlowError,
  requireBoard,
  requireTicket,
  requireUser,
  ticketPath,
  type BoardCtx,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { listNavTree } from '@/lib/nav';
import type { ActionResult } from '@/lib/result';
import { COLUMN_ORDER, TICKET_ORDER, cuid } from '@/lib/validation';

import {
  createTicket,
  placeTicket,
  setTicketDueDate,
  setTicketPriority,
} from '@/app/(app)/orgs/[orgSlug]/[projectKey]/[boardId]/actions';
import {
  assignTicket,
  createComment,
  deleteTicket,
  updateTicket,
} from '@/app/(app)/orgs/[orgSlug]/[projectKey]/[boardId]/[ticketNumber]/actions';

/**
 * The MCP tool surface (transport lives in `src/app/api/mcp/route.ts`).
 *
 * THIS FILE ADDS NO AUTHORIZATION OF ITS OWN, and that is the point. Every read
 * goes through a `require*` helper from `@/lib/authz` or is a nested/rooted
 * select under an id that helper already proved the caller may see; every write
 * is delegated to the SAME Server Action the web UI submits, so the zod parse,
 * the membership walk, the role checks, the `requireColumnInBoard` guard and the
 * `revalidatePath` calls all still happen exactly once, in one place.
 *
 * Identity arrives as a bearer session token (see `presentedToken()` in
 * `@/lib/session`), so an MCP client is precisely as privileged as the person
 * who minted the token — never more.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A closed, author-written message safe to hand back to the model. Anything that
 * is NOT a ToolError is swallowed by the route and reported generically, so a
 * Prisma message or a stack can never reach the client (SPEC §4.7).
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
    Object.setPrototypeOf(this, ToolError.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* Argument readers                                                            */
/* -------------------------------------------------------------------------- */

type Args = Record<string, unknown>;

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`);
  return value;
}

function requiredString(args: Args, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim() === '') throw new ToolError(`"${key}" is required.`);
  return value;
}

/** Ids are opaque and only ever come from a previous tool result. */
function requiredId(args: Args, key: string): string {
  const parsed = cuid.safeParse(requiredString(args, key));
  if (!parsed.success) {
    throw new ToolError(`"${key}" must be an id returned by list_boards, get_board or search_tickets.`);
  }
  return parsed.data;
}

function optionalInt(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ToolError(`"${key}" must be a non-negative integer.`);
  }
  return value;
}

/** FormData is the Server Action calling convention; these are its only inputs. */
function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

/** Server Actions never throw — they answer with a closed error literal. */
function must(result: ActionResult): { ok: true } {
  if (!result.ok) {
    const fields = result.fieldErrors ? ` (${Object.values(result.fieldErrors).join(' ')})` : '';
    throw new ToolError(`${result.error}${fields}`);
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Shared shaping                                                              */
/* -------------------------------------------------------------------------- */

/** Date-only, UTC — matching how `setTicketDueDate` stores it. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * Columns are addressed by NAME ("In Progress") as well as by id, because a
 * model reasons in names. `boardId` must come from an authorized context: the
 * lookup below is the only thing scoping this query.
 */
async function resolveColumn(boardId: string, needle: string) {
  const columns = await prisma.boardColumn.findMany({
    where: { boardId },
    orderBy: COLUMN_ORDER,
    select: { id: true, name: true },
  });
  const wanted = needle.trim().toLowerCase();
  const match =
    columns.find((column) => column.id === needle) ??
    columns.find((column) => column.name.toLowerCase() === wanted);
  if (!match) {
    throw new ToolError(
      `No column "${needle}" on this board. Available: ${columns.map((c) => c.name).join(', ')}.`,
    );
  }
  return match;
}

/** People are addressed by email or id; never by display name, which is ambiguous. */
async function resolveMember(organizationId: string, needle: string): Promise<string> {
  const membership = await prisma.membership.findFirst({
    where: {
      organizationId,
      user: { OR: [{ id: needle }, { email: needle.trim().toLowerCase() }] },
    },
    select: { userId: true },
  });
  // NOT_FOUND rather than "no such user": assignment must not become a probe for
  // accounts outside this organization (SPEC §7.14).
  if (!membership) throw new ToolError('That person is not a member of this organization.');
  return membership.userId;
}

function priorityOf(value: string): Priority {
  const wanted = value.trim().toUpperCase();
  const match = Object.values(Priority).find((priority) => priority === wanted);
  if (!match) {
    throw new ToolError(`"priority" must be one of: ${Object.values(Priority).join(', ')}.`);
  }
  return match;
}

function boardSummary(ctx: BoardCtx) {
  return {
    boardId: ctx.board.id,
    board: ctx.board.name,
    project: ctx.project.name,
    projectKey: ctx.project.key,
    organization: ctx.org.name,
    yourRole: ctx.role,
    url: boardPath(ctx.org, ctx.project, ctx.board),
  };
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (args: Args) => Promise<unknown>;
};

const STRING = { type: 'string' } as const;

export const TOOLS: Tool[] = [
  {
    name: 'list_boards',
    title: 'List boards',
    description:
      'Every organization, project and board the signed-in user can reach, with the ids the other tools need. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => ({ organizations: await listNavTree() }),
  },

  {
    name: 'get_board',
    title: 'Read a board',
    description:
      'Columns of a board with the tickets in each, in board order, plus the organization members who can be assigned work.',
    inputSchema: {
      type: 'object',
      properties: { boardId: { ...STRING, description: 'From list_boards.' } },
      required: ['boardId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireBoard(requiredId(args, 'boardId'));

      const columns = await prisma.boardColumn.findMany({
        where: { boardId: ctx.board.id },
        orderBy: COLUMN_ORDER,
        select: {
          id: true,
          name: true,
          tickets: {
            // Belt and braces against a divergent boardId/columnId pair (SPEC §8.7).
            where: { boardId: ctx.board.id },
            orderBy: TICKET_ORDER,
            select: {
              id: true,
              number: true,
              title: true,
              priority: true,
              dueDate: true,
              updatedAt: true,
              assignee: { select: { id: true, name: true } },
              _count: { select: { comments: true } },
            },
          },
        },
      });

      const members = await prisma.membership.findMany({
        where: { organizationId: ctx.org.id },
        orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
      });

      return {
        ...boardSummary(ctx),
        columns: columns.map((column) => ({
          name: column.name,
          columnId: column.id,
          tickets: column.tickets.map((ticket) => ({
            ticketId: ticket.id,
            ref: `${ctx.project.key}-${ticket.number}`,
            title: ticket.title,
            priority: ticket.priority,
            dueDate: isoDate(ticket.dueDate),
            assignee: ticket.assignee?.name ?? null,
            comments: ticket._count.comments,
            updatedAt: ticket.updatedAt.toISOString(),
          })),
        })),
        members: members.map((row) => ({
          userId: row.user.id,
          name: row.user.name,
          email: row.user.email,
          role: row.role,
        })),
      };
    },
  },

  {
    name: 'get_ticket',
    title: 'Read a ticket',
    description: 'One ticket in full: description, column, priority, due date, assignee and comments.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: { ...STRING, description: 'From get_board or search_tickets.' } },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));

      // Rooted at ids the walk above already authorized.
      const detail = await prisma.ticket.findFirst({
        where: { id: ctx.ticket.id, boardId: ctx.board.id },
        select: {
          priority: true,
          dueDate: true,
          createdAt: true,
          updatedAt: true,
          column: { select: { name: true } },
          createdBy: { select: { name: true } },
          assignee: { select: { id: true, name: true, email: true } },
          comments: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              body: true,
              createdAt: true,
              author: { select: { name: true } },
            },
          },
        },
      });
      if (!detail) throw new AuthzError('NOT_FOUND');

      return {
        ticketId: ctx.ticket.id,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        column: detail.column.name,
        priority: detail.priority,
        dueDate: isoDate(detail.dueDate),
        assignee: detail.assignee,
        createdBy: detail.createdBy.name,
        createdAt: detail.createdAt.toISOString(),
        updatedAt: detail.updatedAt.toISOString(),
        url: ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number),
        boardId: ctx.board.id,
        comments: detail.comments.map((comment) => ({
          commentId: comment.id,
          author: comment.author.name,
          createdAt: comment.createdAt.toISOString(),
          body: comment.body,
        })),
      };
    },
  },

  {
    name: 'search_tickets',
    title: 'Search tickets',
    description:
      'Case-insensitive substring search over ticket titles and descriptions, across every board the user can reach.',
    inputSchema: {
      type: 'object',
      properties: {
        query: STRING,
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const user = await requireUser();
      const query = requiredString(args, 'query');
      const limit = Math.min(optionalInt(args, 'limit') ?? 20, 50) || 20;

      // The membership predicate is part of the lookup, exactly as in @/lib/authz:
      // a ticket in another tenant is not "forbidden", it simply does not match.
      const rows = await prisma.ticket.findMany({
        where: {
          board: { project: { organization: { memberships: { some: { userId: user.id } } } } },
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          dueDate: true,
          updatedAt: true,
          column: { select: { name: true } },
          assignee: { select: { name: true } },
          board: {
            select: {
              id: true,
              name: true,
              project: { select: { key: true, name: true } },
            },
          },
        },
      });

      return {
        query,
        count: rows.length,
        tickets: rows.map((ticket) => ({
          ticketId: ticket.id,
          ref: `${ticket.board.project.key}-${ticket.number}`,
          title: ticket.title,
          column: ticket.column.name,
          priority: ticket.priority,
          dueDate: isoDate(ticket.dueDate),
          assignee: ticket.assignee?.name ?? null,
          board: ticket.board.name,
          boardId: ticket.board.id,
          project: ticket.board.project.name,
          updatedAt: ticket.updatedAt.toISOString(),
        })),
      };
    },
  },

  {
    name: 'create_ticket',
    title: 'Create a ticket',
    description: 'Add a ticket to a board. It lands at the bottom of the named column.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { ...STRING, description: 'From list_boards.' },
        title: STRING,
        description: STRING,
        column: { ...STRING, description: 'Column name or id. Defaults to the first column.' },
      },
      required: ['boardId', 'title'],
      additionalProperties: false,
    },
    run: async (args) => {
      const user = await requireUser();
      const ctx = await requireBoard(requiredId(args, 'boardId'));
      const title = requiredString(args, 'title');
      const wanted = optionalString(args, 'column');

      const column = wanted
        ? await resolveColumn(ctx.board.id, wanted)
        : ((await prisma.boardColumn.findFirst({
            where: { boardId: ctx.board.id },
            orderBy: COLUMN_ORDER,
            select: { id: true, name: true },
          })) ?? (() => { throw new ToolError('That board has no columns.'); })());

      must(
        await createTicket(
          null,
          form({
            boardId: ctx.board.id,
            columnId: column.id,
            title,
            description: optionalString(args, 'description') ?? '',
          }),
        ),
      );

      // ponytail: the action returns no id, so the new row is found by
      // (board, creator, title) newest-first. Two identical titles created by the
      // same person in the same instant would return the newer of the two.
      // Upgrade path: have createTicket return the created id.
      const created = await prisma.ticket.findFirst({
        where: { boardId: ctx.board.id, createdById: user.id, title },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, number: true },
      });

      return {
        ok: true,
        ticketId: created?.id ?? null,
        ref: created ? `${ctx.project.key}-${created.number}` : null,
        column: column.name,
        url: created
          ? ticketPath(ctx.org, ctx.project, ctx.board, created.number)
          : boardPath(ctx.org, ctx.project, ctx.board),
      };
    },
  },

  {
    name: 'update_ticket',
    title: 'Update a ticket',
    description:
      'Change any combination of title, description, priority, due date and assignee. Omitted fields are left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: STRING,
        title: STRING,
        description: { ...STRING, description: 'Empty string clears it.' },
        priority: { type: 'string', enum: Object.values(Priority) },
        dueDate: { ...STRING, description: 'YYYY-MM-DD, or an empty string to clear it.' },
        assignee: { ...STRING, description: 'Member email or userId; empty string unassigns.' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      const ticketId = ctx.ticket.id;

      const title = optionalString(args, 'title');
      const description = optionalString(args, 'description');
      const priority = optionalString(args, 'priority');
      const dueDate = optionalString(args, 'dueDate');
      const assignee = optionalString(args, 'assignee');

      const changed: string[] = [];

      if (title !== undefined || description !== undefined) {
        // updateTicket writes both fields, so the untouched one is re-sent as-is.
        must(
          await updateTicket(
            null,
            form({
              ticketId,
              title: title ?? ctx.ticket.title,
              description: description ?? ctx.ticket.description ?? '',
            }),
          ),
        );
        changed.push(title !== undefined ? 'title' : '', description !== undefined ? 'description' : '');
      }

      if (priority !== undefined) {
        must(await setTicketPriority({ ticketId, priority: priorityOf(priority) }));
        changed.push('priority');
      }

      if (dueDate !== undefined) {
        must(await setTicketDueDate({ ticketId, dueDate: dueDate.trim() === '' ? null : dueDate.trim() }));
        changed.push('dueDate');
      }

      if (assignee !== undefined) {
        const assigneeId =
          assignee.trim() === '' ? '' : await resolveMember(ctx.org.id, assignee);
        must(await assignTicket(null, form({ ticketId, assigneeId })));
        changed.push('assignee');
      }

      const updated = changed.filter(Boolean);
      if (updated.length === 0) throw new ToolError('Nothing to update — pass at least one field.');

      return {
        ok: true,
        ticketId,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        updated,
        url: ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number),
      };
    },
  },

  {
    name: 'move_ticket',
    title: 'Move a ticket',
    description:
      'Move a ticket to another column of its own board, optionally to a specific 0-based position. Appends when position is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: STRING,
        column: { ...STRING, description: 'Target column name or id.' },
        position: { type: 'integer', minimum: 0, description: '0 puts it at the top.' },
      },
      required: ['ticketId', 'column'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      // The ticket's OWN board, from the authorized row — never a client id.
      const column = await resolveColumn(ctx.ticket.boardId, requiredString(args, 'column'));

      // placeTicket clamps to the end of the column, so the cap doubles as "append".
      must(
        await placeTicket({
          ticketId: ctx.ticket.id,
          toColumnId: column.id,
          toIndex: optionalInt(args, 'position') ?? 10_000,
        }),
      );

      return {
        ok: true,
        ticketId: ctx.ticket.id,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        column: column.name,
      };
    },
  },

  {
    name: 'comment_ticket',
    title: 'Comment on a ticket',
    description: 'Post a comment, authored by the owner of the token.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: STRING, body: STRING },
      required: ['ticketId', 'body'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      must(await createComment(null, form({ ticketId: ctx.ticket.id, body: requiredString(args, 'body') })));
      return {
        ok: true,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        url: ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number),
      };
    },
  },

  {
    name: 'delete_ticket',
    title: 'Delete a ticket',
    description:
      'Permanently delete a ticket and its comments. Allowed for the ticket author, or for an ADMIN or OWNER of the organization.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: STRING },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      const ref = `${ctx.project.key}-${ctx.ticket.number}`;

      // deleteTicket signals success by throwing redirect() — that is navigation
      // for the browser, and simply "done" here.
      try {
        must(await deleteTicket(null, form({ ticketId: ctx.ticket.id })));
      } catch (e) {
        if (!isNextControlFlowError(e)) throw e;
      }

      return { ok: true, deleted: ref };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The wire shape for `tools/list` — everything except the handler. */
export function toolDescriptors() {
  return TOOLS.map(({ run: _run, ...descriptor }) => descriptor);
}
