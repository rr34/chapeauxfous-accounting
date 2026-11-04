# Chapeaux Fous Accounting

## Production deployment and database migration

The production checkout is `/srv/chapeauxfous-accounting`. Nginx serves the
static client directly from `client/dist`, so rebuilding the client does not
require a client-process or nginx restart. The Node API runs in PM2 as
`accounting-api`.

For an update with no pending database migration:

```bash
cd /srv/chapeauxfous-accounting
git pull
npm ci
npm run build

pm2 restart accounting-api
pm2 status
pm2 logs accounting-api --lines 100 --nostream
```

Restart `accounting-api` only when API code, dependencies, or environment
values changed. A client-only update takes effect as soon as `npm run build`
replaces `client/dist`; a browser hard refresh may be needed for cached assets.

When an update contains a database migration, update and build the checkout but
do not restart the API yet:

```bash
cd /srv/chapeauxfous-accounting
git pull
npm ci
npm run build
```

Then follow
[Back up and prove the backup restores](DEVELOPMENT.md#back-up-and-prove-the-backup-restores).
Do not treat a nonempty dump as sufficient: retain its SHA-256 file and prove
that the dump restores into a separate verification database.

After the backup procedure prints `Verified recoverable backup`, stop the API
writer, migrate, verify, and start it again:

```bash
cd /srv/chapeauxfous-accounting

pm2 stop accounting-api

ACCOUNTING_MIGRATION_BACKUP_CONFIRMED=1 npm run schema:migrate
npm run schema:verify

pm2 start accounting-api
pm2 status
pm2 logs accounting-api --lines 100 --nostream
```

Do not start the API if either migration or verification fails. MariaDB schema
changes may commit implicitly, so use the verified backup and the recovery
notes in the relevant `db/migrations.sql` block instead of assuming the whole
migration can be rolled back transactionally. The migration runner reads
`api/.env`, applies pending blocks from `db/migrations.sql` oldest-first, and
records the completed version in `accounting_schema_metadata`.

For the current situation—where the code and client are already updated and
built—complete the backup proof, then run only the second command sequence
beginning with `pm2 stop accounting-api`.

## Debit and credit reminder

Increase an asset is a debit
Increase an expense is a debit

Increase a liability is a credit
Increase a revenue is a credit
Increase an equity is a credit
