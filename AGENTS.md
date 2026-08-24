# Chapeaux Fous Accounting repository instructions

These instructions apply to the entire repository.

## Source control

- Do not stage, commit, tag, or push changes merely because a requested change
  is complete.
- Leave completed work as uncommitted working-tree changes for the user to
  review.
- Commit or push only when the user explicitly asks for that source-control
  action in the current turn.
- Read-only Git commands are allowed when they help inspect history or verify
  the working tree.

## Local collaboration

- Do not edit `README.md` unless the user explicitly requests it in that turn.
- Do not run routine full project builds after code edits. Run builds only when
  the user explicitly requests one or when a build is needed to diagnose a
  repeated compile or runtime failure. Prefer the smallest relevant check.
- Do not rely on the edited-files UI to communicate paths. When paths matter,
  list changed files using clickable absolute paths in user-facing summaries.
- Preserve unrelated working-tree changes; they belong to the user unless
  clearly identified otherwise.

## Database and migrations

- MariaDB behavior is authoritative.
- `db/migrations.sql` is the single append-only migration ledger. Add new
  migrations as newest-first, consecutively numbered blocks; the runner applies
  them oldest-first.
- Never rewrite a migration that may already have been applied. Correct it with
  a new migration.
- Do not create one file per migration.
- `db/schema.sql` is the original bootstrap schema snapshot, not a replacement
  for the migration ledger. Do not regenerate it from production unless the
  user explicitly asks to replace the bootstrap snapshot.
- Before applying a migration to a database containing user data, create and
  verify a recoverable backup. Use the repository migration and verification
  commands documented in `db/MIGRATIONS.md`.
- Keep foreign keys straightforward and single-column. Enforce cross-row and
  double-entry accounting invariants centrally in application code rather than
  through composite foreign keys or complex database constraints.

## Product and UI

- Do not treat display components as read-only by default. This is the user's
  data; visible data should generally have an in-place way to create, edit,
  update, delete, or otherwise act on it when the product permits that action.
- Names such as `Display`, `Card`, or `ReadOnly` do not by themselves justify a
  passive UI.
- New users begin with a blank ledger: do not create root accounts, choose an
  account type, or assume a base/default currency for them.

## Production server documentation

- `/home/nate/code/tlom2/serverstructure.md` is the single source of truth for
  shared production-server structure, ports, services, domains, certificates,
  logs, and deployment paths.
- When production topology changes, update that document rather than creating a
  competing server-structure document in this repository.
