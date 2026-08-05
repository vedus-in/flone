-- Linear-style project workspace.
--
-- Design: docs/superpowers/specs/2026-08-05-linear-project-workspace-design.md
--
-- The Project becomes the team. Workflow states move up from the board to the
-- project, ticket numbers become unique per project, and the board becomes an
-- optional grouping.
--
-- DATA-PRESERVING. Every existing ticket keeps its title, body, comments,
-- assignee, priority and due date, and lands on the workflow state matching the
-- column it was in. Ticket numbers are renumbered ONLY inside projects that
-- actually collide (two boards that both have a #1); a single-board project
-- keeps every number, so its existing ticket URLs still resolve.
--
-- Ids for rows created here are `'c' || <uuid with the hyphens stripped>`.
--
-- The `'c'` prefix and the missing hyphens are NOT cosmetic. Prisma's `cuid()`
-- is a client-side default, so the database has to mint these itself -- but
-- every Server Action validates ids with zod's `.cuid()`, which requires a
-- leading `c` and forbids hyphens. A bare `gen_random_uuid()` would produce
-- rows the UI could READ and no action could ever WRITE: changing an issue's
-- status on a migrated project would fail with "Please check the form and try
-- again", and neither a type check nor a schema diff would say why.

-- CreateEnum
CREATE TYPE "WorkflowStateType" AS ENUM ('BACKLOG', 'UNSTARTED', 'STARTED', 'COMPLETED', 'CANCELED');
CREATE TYPE "BoardStatus" AS ENUM ('BACKLOG', 'PLANNED', 'STARTED', 'PAUSED', 'COMPLETED', 'CANCELED');

-- CreateTable
CREATE TABLE "WorkflowState" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WorkflowStateType" NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Cycle" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cycle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- Prisma's implicit m:n join table. The composite PRIMARY KEY (not a unique
-- index) and the `_AB_pkey` / `_B_index` names are the shape Prisma 6 expects;
-- anything else reads as schema drift on the next `migrate` run.
CREATE TABLE "_TicketLabels" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TicketLabels_AB_pkey" PRIMARY KEY ("A","B")
);

-- AlterTable: cycle cadence on the project
ALTER TABLE "Project" ADD COLUMN "cyclesEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Project" ADD COLUMN "cycleWeeks" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Project" ADD COLUMN "cycleStartDay" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Project" ADD COLUMN "upcomingCycles" INTEGER NOT NULL DEFAULT 3;

-- AlterTable: the board becomes Linear's project
ALTER TABLE "Board" ADD COLUMN "description" TEXT;
ALTER TABLE "Board" ADD COLUMN "status" "BoardStatus" NOT NULL DEFAULT 'BACKLOG';
ALTER TABLE "Board" ADD COLUMN "color" TEXT NOT NULL DEFAULT 'gray';
ALTER TABLE "Board" ADD COLUMN "leadId" TEXT;
ALTER TABLE "Board" ADD COLUMN "targetDate" TIMESTAMP(3);

-- AlterTable: new ticket columns, nullable for now so the backfill can run
ALTER TABLE "Ticket" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "stateId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "cycleId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "parentId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "completedAt" TIMESTAMP(3);

/* ========================================================================== */
/* Data migration                                                             */
/* ========================================================================== */

-- 1. Collapse each project's board columns into project workflow states.
--
--    Distinct by name within the project, so "In Progress" on three boards
--    becomes one state. The type is inferred from the name; anything
--    unrecognised is STARTED, which is the safe guess -- it keeps the issue
--    under the Active tab rather than hiding it in a backlog nobody reads.
--
--    `position` is the BOARD order (backlog on the left, canceled on the
--    right). The issue list's group order is a separate rank derived in the
--    app, so the two views can differ without a second column here.
INSERT INTO "WorkflowState" ("id", "projectId", "name", "type", "color", "position", "createdAt")
SELECT
    ('c' || replace(gen_random_uuid()::text, '-', '')),
    s."projectId",
    s."name",
    s."type",
    s."color",
    (row_number() OVER (PARTITION BY s."projectId" ORDER BY s."rank", s."minPosition", s."name"))::int - 1,
    CURRENT_TIMESTAMP
FROM (
    SELECT
        b."projectId",
        c."name",
        min(c."position") AS "minPosition",
        (CASE
            WHEN lower(c."name") LIKE '%backlog%' THEN 'BACKLOG'
            WHEN lower(c."name") LIKE 'cancel%'
              OR lower(c."name") LIKE '%duplicate%'
              OR lower(c."name") LIKE 'won%t %' THEN 'CANCELED'
            WHEN lower(c."name") LIKE '%done%'
              OR lower(c."name") LIKE '%complete%'
              OR lower(c."name") LIKE '%closed%'
              OR lower(c."name") LIKE '%shipped%' THEN 'COMPLETED'
            WHEN lower(c."name") IN ('to do', 'todo', 'open', 'new', 'triage', 'unstarted') THEN 'UNSTARTED'
            ELSE 'STARTED'
        END)::"WorkflowStateType" AS "type",
        (CASE
            WHEN lower(c."name") LIKE '%backlog%' THEN 0
            WHEN lower(c."name") LIKE 'cancel%'
              OR lower(c."name") LIKE '%duplicate%'
              OR lower(c."name") LIKE 'won%t %' THEN 4
            WHEN lower(c."name") LIKE '%done%'
              OR lower(c."name") LIKE '%complete%'
              OR lower(c."name") LIKE '%closed%'
              OR lower(c."name") LIKE '%shipped%' THEN 3
            WHEN lower(c."name") IN ('to do', 'todo', 'open', 'new', 'triage', 'unstarted') THEN 1
            ELSE 2
        END) AS "rank",
        (CASE
            WHEN lower(c."name") LIKE '%backlog%' THEN 'gray'
            WHEN lower(c."name") LIKE 'cancel%'
              OR lower(c."name") LIKE '%duplicate%'
              OR lower(c."name") LIKE 'won%t %' THEN 'gray'
            WHEN lower(c."name") LIKE '%done%'
              OR lower(c."name") LIKE '%complete%'
              OR lower(c."name") LIKE '%closed%'
              OR lower(c."name") LIKE '%shipped%' THEN 'success'
            WHEN lower(c."name") IN ('to do', 'todo', 'open', 'new', 'triage', 'unstarted') THEN 'gray'
            ELSE 'warning'
        END) AS "color"
    FROM "BoardColumn" c
    JOIN "Board" b ON b."id" = c."boardId"
    GROUP BY b."projectId", c."name"
) s;

-- 2. A project with no boards (or boards with no columns) got nothing above.
--    Give it the default set so it can still express every tab.
INSERT INTO "WorkflowState" ("id", "projectId", "name", "type", "color", "position", "createdAt")
SELECT ('c' || replace(gen_random_uuid()::text, '-', '')), p."id", d."name", d."type"::"WorkflowStateType", d."color", d."position", CURRENT_TIMESTAMP
FROM "Project" p
CROSS JOIN (VALUES
    ('Backlog',     'BACKLOG',   'gray',    0),
    ('Todo',        'UNSTARTED', 'gray',    1),
    ('In Progress', 'STARTED',   'warning', 2),
    ('In Review',   'STARTED',   'brand',   3),
    ('Done',        'COMPLETED', 'success', 4),
    ('Canceled',    'CANCELED',  'gray',    5)
) AS d("name", "type", "color", "position")
WHERE NOT EXISTS (SELECT 1 FROM "WorkflowState" w WHERE w."projectId" = p."id");

-- 3. Every project needs a BACKLOG and a CANCELED state, or the Backlog tab and
--    the "cancel this issue" affordance have nothing to point at. Append only
--    what is missing, after the states that already exist.
INSERT INTO "WorkflowState" ("id", "projectId", "name", "type", "color", "position", "createdAt")
SELECT ('c' || replace(gen_random_uuid()::text, '-', '')), p."id", 'Backlog', 'BACKLOG', 'gray',
       COALESCE((SELECT max(w."position") + 1 FROM "WorkflowState" w WHERE w."projectId" = p."id"), 0),
       CURRENT_TIMESTAMP
FROM "Project" p
WHERE NOT EXISTS (
    SELECT 1 FROM "WorkflowState" w WHERE w."projectId" = p."id" AND w."type" = 'BACKLOG'
) AND NOT EXISTS (
    SELECT 1 FROM "WorkflowState" w WHERE w."projectId" = p."id" AND w."name" = 'Backlog'
);

INSERT INTO "WorkflowState" ("id", "projectId", "name", "type", "color", "position", "createdAt")
SELECT ('c' || replace(gen_random_uuid()::text, '-', '')), p."id", 'Canceled', 'CANCELED', 'gray',
       COALESCE((SELECT max(w."position") + 1 FROM "WorkflowState" w WHERE w."projectId" = p."id"), 0),
       CURRENT_TIMESTAMP
FROM "Project" p
WHERE NOT EXISTS (
    SELECT 1 FROM "WorkflowState" w WHERE w."projectId" = p."id" AND w."type" = 'CANCELED'
) AND NOT EXISTS (
    SELECT 1 FROM "WorkflowState" w WHERE w."projectId" = p."id" AND w."name" = 'Canceled'
);

-- 3b. Normalize board order across every project.
--
--     Steps 1-3 append what was missing, which leaves a migrated project reading
--     "To Do, In Progress, Done, Backlog, Canceled" on its board -- backlog on
--     the RIGHT, which is backwards. Positions are rewritten here by type rank
--     so every project's board reads left to right the way a kanban should,
--     preserving the project's own relative order within a rank.
WITH ordered AS (
    SELECT w."id",
           (row_number() OVER (
               PARTITION BY w."projectId"
               ORDER BY
                   CASE w."type"
                       WHEN 'BACKLOG'   THEN 0
                       WHEN 'UNSTARTED' THEN 1
                       WHEN 'STARTED'   THEN 2
                       WHEN 'COMPLETED' THEN 3
                       WHEN 'CANCELED'  THEN 4
                   END,
                   w."position",
                   w."name"
           ))::int - 1 AS "position"
    FROM "WorkflowState" w
)
UPDATE "WorkflowState" w
SET "position" = o."position"
FROM ordered o
WHERE w."id" = o."id";

-- 4. Point every ticket at its project, then at the state named like its old
--    column.
UPDATE "Ticket" t
SET "projectId" = b."projectId"
FROM "Board" b
WHERE b."id" = t."boardId";

UPDATE "Ticket" t
SET "stateId" = w."id"
FROM "BoardColumn" c, "WorkflowState" w
WHERE c."id" = t."columnId"
  AND w."projectId" = t."projectId"
  AND w."name" = c."name";

-- Belt and braces: anything the name join missed lands on the project's first
-- state rather than blocking the NOT NULL below.
UPDATE "Ticket" t
SET "stateId" = (
    SELECT w."id" FROM "WorkflowState" w
    WHERE w."projectId" = t."projectId"
    ORDER BY w."position", w."id"
    LIMIT 1
)
WHERE t."stateId" IS NULL;

-- 5. Stamp completedAt on everything already in a COMPLETED state, so the first
--    cycle burndown is not drawn as if all historic work finished today.
UPDATE "Ticket" t
SET "completedAt" = t."updatedAt"
FROM "WorkflowState" w
WHERE w."id" = t."stateId" AND w."type" = 'COMPLETED';

UPDATE "Ticket" t
SET "startedAt" = t."updatedAt"
FROM "WorkflowState" w
WHERE w."id" = t."stateId" AND w."type" IN ('STARTED', 'COMPLETED');

-- 6. Renumber ONLY the projects whose ticket numbers collide once they are
--    pooled per project. A project with one board never collides, so it keeps
--    every number and every existing ticket URL still resolves.
WITH colliding AS (
    SELECT "projectId"
    FROM "Ticket"
    GROUP BY "projectId", "number"
    HAVING count(*) > 1
),
renumbered AS (
    SELECT t."id",
           (row_number() OVER (PARTITION BY t."projectId" ORDER BY t."createdAt", t."id"))::int AS "n"
    FROM "Ticket" t
    WHERE t."projectId" IN (SELECT DISTINCT "projectId" FROM colliding)
)
UPDATE "Ticket" t
SET "number" = r."n"
FROM renumbered r
WHERE t."id" = r."id";

/* ========================================================================== */
/* Constraints                                                                */
/* ========================================================================== */

-- The backfill is done; these can be enforced now.
ALTER TABLE "Ticket" ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "Ticket" ALTER COLUMN "stateId" SET NOT NULL;
ALTER TABLE "Ticket" ALTER COLUMN "boardId" DROP NOT NULL;

-- DropOldConstraints
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_columnId_fkey";
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_boardId_fkey";
DROP INDEX "Ticket_boardId_number_key";
DROP INDEX "Ticket_columnId_position_idx";
DROP INDEX "Ticket_boardId_priority_idx";
DROP INDEX "Ticket_boardId_dueDate_idx";
ALTER TABLE "Ticket" DROP COLUMN "columnId";

-- DropTable
DROP TABLE "BoardColumn";

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowState_projectId_name_key" ON "WorkflowState"("projectId", "name");
CREATE INDEX "WorkflowState_projectId_position_idx" ON "WorkflowState"("projectId", "position");
CREATE UNIQUE INDEX "Cycle_projectId_number_key" ON "Cycle"("projectId", "number");
CREATE INDEX "Cycle_projectId_startsAt_idx" ON "Cycle"("projectId", "startsAt");
CREATE UNIQUE INDEX "Label_projectId_name_key" ON "Label"("projectId", "name");
CREATE INDEX "SavedView_projectId_name_idx" ON "SavedView"("projectId", "name");
CREATE INDEX "SavedView_createdById_idx" ON "SavedView"("createdById");
CREATE INDEX "_TicketLabels_B_index" ON "_TicketLabels"("B");

CREATE UNIQUE INDEX "Ticket_projectId_number_key" ON "Ticket"("projectId", "number");
CREATE INDEX "Ticket_projectId_stateId_position_idx" ON "Ticket"("projectId", "stateId", "position");
CREATE INDEX "Ticket_projectId_priority_idx" ON "Ticket"("projectId", "priority");
CREATE INDEX "Ticket_projectId_dueDate_idx" ON "Ticket"("projectId", "dueDate");
CREATE INDEX "Ticket_boardId_idx" ON "Ticket"("boardId");
CREATE INDEX "Ticket_cycleId_idx" ON "Ticket"("cycleId");
CREATE INDEX "Ticket_parentId_idx" ON "Ticket"("parentId");
CREATE INDEX "Ticket_stateId_idx" ON "Ticket"("stateId");

-- AddForeignKey
ALTER TABLE "WorkflowState" ADD CONSTRAINT "WorkflowState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Label" ADD CONSTRAINT "Label_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Board" ADD CONSTRAINT "Board_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ticket.boardId is now SET NULL: deleting a board drops the chip and KEEPS the
-- issues. This is a deliberate behaviour change -- it used to cascade them away.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "WorkflowState"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "_TicketLabels" ADD CONSTRAINT "_TicketLabels_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_TicketLabels" ADD CONSTRAINT "_TicketLabels_B_fkey" FOREIGN KEY ("B") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
