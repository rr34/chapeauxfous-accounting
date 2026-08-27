# Chapeaux Fous Accounting MariaDB migrations

`migrations.sql` is the append-only migration ledger. Add new blocks directly
below its header, newest first. The API migration runner validates that layout
and applies pending blocks oldest first.

Migration `0001` establishes version tracking on the existing core accounting
schema represented by `schema.sql`. Migration `0002` adds the minimal TLOM-style
person identity, one-ledger-per-person ownership, import identities, and the
indexes required by the API.

The complete operator procedure, including the MariaDB dump, isolated test
restore, checksum, migration, and verification commands, is in
`DEVELOPMENT.md` under **Back up and prove the backup restores**. Follow that
procedure for every database containing user data. MariaDB DDL may commit
implicitly, so never blindly rerun a partially failed migration.
