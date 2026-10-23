# Data model

- **User** — email (unique, lowercased), name, password hash, `emailVerified` timestamp, and three notification switches.
  - **Session** — SHA-256 token hash (unique), expiry. Deleted with the user.
  - **EmailToken** — SHA-256 token hash (unique), purpose (`EMAIL_VERIFY`, `PASSWORD_RESET`, `INVITE`), the address it was issued to, expiry, and `usedAt`. An `INVITE` also carries the organization and the role it grants, and has no user until it is accepted. Deleted with the user or the organization.
- **Organization** — name, unique slug. The tenant boundary; deleting it cascades to everything below.
  - **Membership** — joins a user to an organization with a role of `OWNER`, `ADMIN`, or `MEMBER`. One per user per organization.
  - **Project** — name, key (unique within the organization), optional description.
    - **Board** — name.
      - **BoardColumn** — name and position. Always exactly `To Do` (0), `In Progress` (1), `Done` (2).
      - **Ticket** — sequential number (unique within the board), title, optional description, position, creator, optional assignee. Belongs to one board and one of that board's columns.
        - **Comment** — plain-text body, author.
        - **Attachment** — an uploaded image: bucket object key, filename, MIME type, size, uploader. Owned by the **project**, with the issue link optional, because an image can be pasted into a description that has no row yet (the new-issue dialog, a recurring template). Referenced from Markdown and nothing parses that text, so editing an image out of a body never deletes a file. Cascades with the issue when it has one and with the project either way; the bucket object is deleted best-effort on the issue delete path.

    - **Document** — title, Markdown body, optional parent document, author. A long-form page owned by the **project**, nested by `parentId` to any depth; siblings read alphabetically, because nothing drags them into an order. The parent chain is kept acyclic by the application (`src/lib/documents.ts`) — a cycle would be a page render that never terminates, not merely wrong data. Deleting one cascades to the whole subtree, and there is no trash. `shareToken` is null until the document is published on a public link and is the entire access rule for one; it is stored raw, because the row it guards holds the body in the next column.

Creators of tickets, authors of comments, authors of documents and uploaders of attachments are `Restrict` references, so a user row cannot be deleted while their work exists. An assignee is `SetNull`. Everything else in the tree cascades from the organization down.
