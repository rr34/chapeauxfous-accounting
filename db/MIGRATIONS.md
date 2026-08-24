# Chapeaux Fous Accounting MariaDB migrations

`migrations.sql` is the append-only migration ledger. Add new blocks directly
below its header, newest first. The API migration runner validates that layout
and applies pending blocks oldest first.

Migration `0001` establishes version tracking on the existing core accounting
schema represented by `schema.sql`. Migration `0002` adds the minimal TLOM-style
person identity, one-ledger-per-person ownership, import identities, and the
indexes required by the API.

MariaDB DDL may commit implicitly. Before production migrations, create and
verify a recoverable database backup, stop application writers when a migration
requires it, and never blindly rerun a partially failed migration.

Local commands, from the repository root:

```bash
npm run schema:migrate
npm run schema:verify
```

The migrator requires `ACCOUNTING_MIGRATION_BACKUP_CONFIRMED=1` whenever
pending migrations exist. This flag is an operator assertion; it does not make
a backup by itself.

