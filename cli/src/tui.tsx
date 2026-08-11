import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { resolveBoard, resolveProject, type Board, type Card, type Me, type Project } from './api.js';
import { readConfig } from './config.js';
import { CliError, type Call } from './mcp.js';
import type { Ctx } from './commands.js';

/**
 * The interactive board.
 *
 * Ink rather than hand-rolled escape sequences: a redraw-on-state-change layout
 * engine is exactly the part that is tedious and easy to get wrong, and the app
 * is already a React codebase.
 *
 * The board is a SNAPSHOT. Flone has no realtime channel, so this refreshes on
 * `r` and after every mutation, and deliberately does not poll — a background
 * timer redrawing under someone's cursor is worse than a stale count.
 */

const PRIORITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const PRIORITY_COLOR: Record<string, string | undefined> = {
  URGENT: 'red',
  HIGH: 'yellow',
  MEDIUM: 'blue',
  LOW: undefined,
  NONE: undefined,
};

const STATE_COLOR: Record<string, string | undefined> = {
  BACKLOG: undefined,
  UNSTARTED: 'white',
  STARTED: 'yellow',
  COMPLETED: 'green',
  CANCELED: undefined,
};

type Overlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'prompt'; label: string; initial: string; run: (value: string) => Promise<void> }
  | {
      kind: 'picker';
      label: string;
      items: { label: string; value: string }[];
      run: (value: string) => Promise<void>;
    }
  | { kind: 'confirm'; label: string; run: () => Promise<void> };

/** Everything except the closed state — what the overlay component can receive. */
type Open = Exclude<Overlay, { kind: 'none' }>;

type Loaded = { project: Project; board: Board; me: Me };

export async function runBoard(ctx: Ctx): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new CliError('The board needs a terminal. Run `flone ls` instead, or `flone help`.');
  }

  const config = readConfig()!;
  const where = await resolveProject(
    ctx.call,
    typeof ctx.flags['project'] === 'string' ? ctx.flags['project'] : undefined,
    config.project,
  );

  const project = await ctx.call<Project>('get_project', where);
  const boardId = resolveBoard(
    project,
    typeof ctx.flags['board'] === 'string' ? ctx.flags['board'] : undefined,
  );

  const [board, me] = await Promise.all([
    ctx.call<Board>('get_board', { boardId }),
    ctx.call<Me>('whoami'),
  ]);

  const app = render(<App call={ctx.call} initial={{ project, board, me }} />);
  await app.waitUntilExit();
}

/* -------------------------------------------------------------------------- */

function App({ call, initial }: { call: Call; initial: Loaded }): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [data, setData] = useState(initial);
  const [column, setColumn] = useState(0);
  const [row, setRow] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(true);
  const [width, setWidth] = useState(stdout.columns ?? 100);

  useEffect(() => {
    const onResize = () => setWidth(stdout.columns ?? 100);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const columns = data.board.columns;
  const current = columns[Math.min(column, columns.length - 1)];
  const cards = current?.tickets ?? [];
  const card = cards[Math.min(row, Math.max(0, cards.length - 1))];

  const refresh = useCallback(async () => {
    const [board, project] = await Promise.all([
      call<Board>('get_board', { boardId: data.board.boardId }),
      call<Project>('get_project', {
        orgSlug: data.project.orgSlug,
        projectKey: data.project.projectKey,
      }),
    ]);
    setData((previous) => ({ ...previous, board, project }));
  }, [call, data.board.boardId, data.project.orgSlug, data.project.projectKey]);

  /** Every mutation goes through here, so none of them can forget to refresh. */
  const act = useCallback(
    async (what: string, run: () => Promise<unknown>) => {
      setBusy(true);
      setMessage(null);
      try {
        await run();
        await refresh();
        setMessage({ text: what, bad: false });
      } catch (e) {
        // The server's messages are written for people; show them unchanged.
        setMessage({ text: e instanceof Error ? e.message : String(e), bad: true });
      } finally {
        setBusy(false);
        setOverlay({ kind: 'none' });
      }
    },
    [refresh],
  );

  /**
   * `[` and `]` apply locally before the call returns — the whole point of a
   * board is that moving feels instant — and the refresh in `act` is what puts
   * the authoritative order back. A failure leaves the message and the next
   * refresh corrects the position.
   */
  const nudge = useCallback(
    (delta: number) => {
      if (!card || !current) return;
      const target = columns[column + delta];
      if (!target) return;

      setData((previous) => ({
        ...previous,
        board: {
          ...previous.board,
          columns: previous.board.columns.map((entry) =>
            entry.stateId === current.stateId
              ? { ...entry, tickets: entry.tickets.filter((t) => t.ticketId !== card.ticketId) }
              : entry.stateId === target.stateId
                ? { ...entry, tickets: [...entry.tickets, card] }
                : entry,
          ),
        },
      }));
      setColumn(column + delta);
      setRow(target.tickets.length);

      void act(`${card.ref} → ${target.name}`, () =>
        call('move_ticket', { ticketId: card.ticketId, status: target.stateId }),
      );
    },
    [act, call, card, column, columns, current],
  );

  const members = data.board.members;

  useInput(
    (input, key) => {
      if (busy) return;

      if (key.leftArrow || input === 'h') {
        setColumn((c) => Math.max(0, c - 1));
        setRow(0);
      } else if (key.rightArrow || input === 'l') {
        setColumn((c) => Math.min(columns.length - 1, c + 1));
        setRow(0);
      } else if (key.downArrow || input === 'j') {
        setRow((r) => Math.min(cards.length - 1, r + 1));
      } else if (key.upArrow || input === 'k') {
        setRow((r) => Math.max(0, r - 1));
      } else if (key.return) {
        setDetail((d) => !d);
      } else if (input === '[') {
        nudge(-1);
      } else if (input === ']') {
        nudge(1);
      } else if (input === 'r') {
        void act('refreshed', async () => undefined);
      } else if (input === '?') {
        setOverlay({ kind: 'help' });
      } else if (input === 'q' || key.escape) {
        exit();
      } else if (input === 'n') {
        setOverlay({
          kind: 'prompt',
          label: 'New issue',
          initial: '',
          run: async (title) => {
            if (title.trim() === '') return;
            await act(`created "${title}"`, () =>
              call('create_ticket', {
                orgSlug: data.project.orgSlug,
                projectKey: data.project.projectKey,
                title,
                board: data.board.board,
                ...(current ? { status: current.stateId } : {}),
              }),
            );
          },
        });
      } else if (!card) {
        // Everything below acts on a selected card.
        return;
      } else if (input === 'e') {
        setOverlay({
          kind: 'prompt',
          label: `Title of ${card.ref}`,
          initial: card.title,
          run: async (title) => {
            if (title.trim() === '' || title === card.title) {
              setOverlay({ kind: 'none' });
              return;
            }
            await act(`renamed ${card.ref}`, () =>
              call('update_ticket', { ticketId: card.ticketId, title }),
            );
          },
        });
      } else if (input === 'c') {
        setOverlay({
          kind: 'prompt',
          label: `Comment on ${card.ref}`,
          initial: '',
          run: async (body) => {
            if (body.trim() === '') {
              setOverlay({ kind: 'none' });
              return;
            }
            await act(`commented on ${card.ref}`, () =>
              call('create_comment', { ticketId: card.ticketId, body }),
            );
          },
        });
      } else if (input === 'm') {
        setOverlay({
          kind: 'picker',
          label: `Move ${card.ref} to`,
          items: columns.map((entry) => ({ label: entry.name, value: entry.stateId })),
          run: async (stateId) =>
            act(`moved ${card.ref}`, () =>
              call('move_ticket', { ticketId: card.ticketId, status: stateId }),
            ),
        });
      } else if (input === 'p') {
        setOverlay({
          kind: 'picker',
          label: `Priority of ${card.ref}`,
          items: PRIORITIES.map((value) => ({ label: value.toLowerCase(), value })),
          run: async (priority) =>
            act(`${card.ref} is ${priority.toLowerCase()}`, () =>
              call('update_ticket', { ticketId: card.ticketId, priority }),
            ),
        });
      } else if (input === 'a') {
        setOverlay({
          kind: 'picker',
          label: `Assign ${card.ref} to`,
          items: [
            { label: 'nobody', value: '' },
            ...members.map((m) => ({ label: `${m.name} <${m.email}>`, value: m.email })),
          ],
          run: async (email) =>
            act(email === '' ? `${card.ref} unassigned` : `${card.ref} → ${email}`, () =>
              call('update_ticket', { ticketId: card.ticketId, assignee: email }),
            ),
        });
      } else if (input === 'b') {
        setOverlay({
          kind: 'picker',
          label: 'Open board',
          items: data.project.boards.map((b) => ({ label: b.name, value: b.boardId })),
          run: async (boardId) => {
            setBusy(true);
            try {
              const board = await call<Board>('get_board', { boardId });
              setData((previous) => ({ ...previous, board }));
              setColumn(0);
              setRow(0);
            } finally {
              setBusy(false);
              setOverlay({ kind: 'none' });
            }
          },
        });
      } else if (input === 'd') {
        setOverlay({
          kind: 'confirm',
          label: `Delete ${card.ref} "${card.title}" and its comments?`,
          run: async () =>
            act(`deleted ${card.ref}`, () => call('delete_ticket', { ticketId: card.ticketId })),
        });
      }
    },
    { isActive: overlay.kind === 'none' },
  );

  // A detail pane needs room for both it and the columns; below that it would
  // squeeze the board into unreadable slivers, so it simply does not appear.
  const roomForDetail = width >= 110;
  const columnWidth = Math.max(
    18,
    Math.floor(((roomForDetail && detail ? width - 40 : width) - 2) / Math.max(1, columns.length)),
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{data.project.project}</Text>
        <Text dimColor> · {data.board.board} · </Text>
        <Text dimColor>{data.me.name}</Text>
      </Box>

      <Box marginTop={1}>
        <Box flexDirection="row">
          {columns.map((entry, index) => (
            <Column
              key={entry.stateId}
              name={entry.name}
              type={entry.type}
              cards={entry.tickets}
              width={columnWidth}
              active={index === column}
              selected={index === column ? Math.min(row, entry.tickets.length - 1) : -1}
            />
          ))}
        </Box>

        {roomForDetail && detail && card ? <Detail call={call} card={card} /> : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {message ? (
          <Text color={message.bad ? 'red' : 'green'}>{message.text}</Text>
        ) : (
          <Text dimColor>
            ←→↑↓ move · enter detail · n new · e title · m status · [ ] nudge · a assign · p
            priority · c comment · d delete · b board · r refresh · ? help · q quit
          </Text>
        )}
        {busy ? <Text dimColor>working…</Text> : null}
      </Box>

      {overlay.kind !== 'none' ? (
        <Overlay overlay={overlay} onClose={() => setOverlay({ kind: 'none' })} />
      ) : null}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */

function Column({
  name,
  type,
  cards,
  width,
  active,
  selected,
}: {
  name: string;
  type: string;
  cards: Card[];
  width: number;
  active: boolean;
  selected: number;
}): ReactElement {
  return (
    <Box flexDirection="column" width={width} paddingRight={1}>
      <Text color={STATE_COLOR[type]} bold={active} dimColor={!active && type === 'BACKLOG'}>
        {name} <Text dimColor>({cards.length})</Text>
      </Text>

      {cards.length === 0 ? (
        <Text dimColor>—</Text>
      ) : (
        cards.map((card, index) => (
          <Box key={card.ticketId} flexDirection="column" marginTop={1}>
            <Text inverse={index === selected} wrap="truncate">
              <Text color="cyan">{card.ref}</Text> {card.title}
            </Text>
            <Text wrap="truncate">
              <Text dimColor>{card.assignee ?? '—'}</Text>
              {card.priority && card.priority !== 'NONE' ? (
                <Text color={PRIORITY_COLOR[card.priority]}> · {card.priority.toLowerCase()}</Text>
              ) : null}
              {card.dueDate ? <Text dimColor> · {card.dueDate}</Text> : null}
              {card.comments > 0 ? <Text dimColor> · {card.comments}c</Text> : null}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

type Full = {
  description: string | null;
  comments: { commentId: string; author: string; body: string }[];
};

function Detail({ call, card }: { call: Call; card: Card }): ReactElement {
  const [full, setFull] = useState<Full | null>(null);

  useEffect(() => {
    let live = true;
    setFull(null);
    call<Full>('get_ticket', { ticketId: card.ticketId })
      .then((ticket) => {
        if (live) setFull(ticket);
      })
      .catch(() => {
        if (live) setFull({ description: null, comments: [] });
      });
    return () => {
      live = false;
    };
  }, [call, card.ticketId]);

  return (
    <Box flexDirection="column" width={38} paddingLeft={1} borderStyle="round" borderDimColor>
      <Text bold wrap="wrap">
        {card.title}
      </Text>
      <Text dimColor>{card.ref}</Text>

      {full === null ? (
        <Text dimColor>loading…</Text>
      ) : (
        <>
          <Box marginTop={1}>
            <Text wrap="wrap">{full.description || <Text dimColor>No description.</Text>}</Text>
          </Box>
          {full.comments.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Comments</Text>
              {full.comments.slice(-3).map((comment) => (
                <Box key={comment.commentId} flexDirection="column" marginTop={1}>
                  <Text bold>{comment.author}</Text>
                  <Text wrap="wrap">{comment.body}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */

const KEYS: [string, string][] = [
  ['←→ h l', 'previous / next column'],
  ['↑↓ j k', 'previous / next issue'],
  ['enter', 'show or hide the detail pane'],
  ['n', 'new issue in this column'],
  ['e', 'rename the selected issue'],
  ['m', 'pick a status'],
  ['[ ]', 'nudge one column left or right'],
  ['a', 'assign'],
  ['p', 'set priority'],
  ['c', 'comment'],
  ['d', 'delete (asks first)'],
  ['b', 'open a different board'],
  ['r', 'refresh'],
  ['q esc', 'quit'],
];

function Overlay({ overlay, onClose }: { overlay: Open; onClose: () => void }): ReactElement {
  const [value, setValue] = useState(overlay.kind === 'prompt' ? overlay.initial : '');
  const [choice, setChoice] = useState(0);

  const items = overlay.kind === 'picker' ? overlay.items : [];

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose();
        return;
      }

      if (overlay.kind === 'picker') {
        if (key.downArrow || input === 'j') setChoice((c) => Math.min(items.length - 1, c + 1));
        else if (key.upArrow || input === 'k') setChoice((c) => Math.max(0, c - 1));
        else if (key.return) void overlay.run(items[choice]!.value);
        return;
      }

      if (overlay.kind === 'confirm') {
        if (/^y$/i.test(input)) void overlay.run();
        else if (/^n$/i.test(input) || key.return) onClose();
        return;
      }

      if (overlay.kind === 'help' && (key.return || input === 'q' || input === '?')) onClose();
    },
    { isActive: overlay.kind !== 'prompt' },
  );

  const frame = (children: ReactNode) => (
    <Box marginTop={1} borderStyle="round" flexDirection="column" paddingX={1}>
      {children}
    </Box>
  );

  if (overlay.kind === 'help') {
    return frame(
      <>
        {KEYS.map(([key, what]) => (
          <Text key={key}>
            <Text color="cyan">{key.padEnd(8)}</Text>
            <Text dimColor>{what}</Text>
          </Text>
        ))}
        <Text dimColor>{'\n'}enter or ? to close</Text>
      </>,
    );
  }

  if (overlay.kind === 'confirm') {
    return frame(
      <>
        <Text color="red">{overlay.label}</Text>
        <Text dimColor>y to confirm · anything else cancels</Text>
      </>,
    );
  }

  if (overlay.kind === 'picker') {
    return frame(
      <>
        <Text bold>{overlay.label}</Text>
        {items.map((item, index) => (
          <Text key={item.value || item.label} inverse={index === choice}>
            {item.label}
          </Text>
        ))}
        <Text dimColor>↑↓ choose · enter to pick · esc to cancel</Text>
      </>,
    );
  }

  return frame(
    <>
      <Text bold>{overlay.label}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={() => void overlay.run(value)} />
      <Text dimColor>enter to save · esc to cancel</Text>
    </>,
  );
}
