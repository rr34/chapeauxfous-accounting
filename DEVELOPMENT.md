# Local development

## Prerequisites

- Node.js with npm
- MariaDB 10.11
- The existing `cfaccounting` database initialized from `db/schema.sql`

## Install and configure

```bash
npm install
cp api/.env.example api/.env
```

Edit `api/.env` with the local or server database credentials and a strong,
random `JWT_SECRET`.

Before applying pending migrations, create and verify a recoverable database
backup. Then run:

```bash
ACCOUNTING_MIGRATION_BACKUP_CONFIRMED=1 npm run schema:migrate
npm run schema:semantics:sync
npm run schema:verify
```

The semantic sync extracts the eight public accounting tables from MariaDB,
preserves the human-written meanings in `db/schema-semantics.json`, and refreshes
compiler-owned mechanics. Review that file and fill any new semantic blanks
before verification. Identity and API-token tables are deliberately excluded
from the agent-facing schema projection.

Migration `0002` expects the new accounting tables to contain no real ledger
data because it establishes required user ownership. If ledger data is added
before this migration, assign it to a person in a dedicated backfill migration
instead of forcing `owner_person_id` to `NOT NULL` directly.

## Run

In separate terminals:

```bash
npm run dev:api
npm run dev:client
```

Open `http://localhost:5173`. Registration creates only the person's identity.
The ledger begins with zero accounts; each account's type, currency, and place
in the optional parent hierarchy are explicit user choices.

## Verification

```bash
npm test
npm run build
npm run schema:verify
```

The API also exposes `POST /api/ledger/verify` for an authenticated user. It
reruns the same central accounting invariants used when posting transactions.

## MCP access

The remote MCP endpoint is `/mcp`. It uses the MCP 2.0 per-request handler,
including modern tool-list discovery and change subscriptions, with stateless
Streamable HTTP compatibility for 2025-era clients. Development clients can
therefore rediscover tools when the API restarts or the app is refreshed; the
MCP connection does not need to be deleted and recreated. It uses a long-lived,
revocable API token instead of OAuth. A token belongs to exactly one accounting
user, and MCP tools can access only that user's ledger.

Create a token by authenticating normally and then calling:

```bash
curl -X POST https://ACCOUNTING_HOST/api/auth/tokens \
  -H "Authorization: Bearer LOGIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"Accounting agent"}'
```

The response contains the `cfacct_...` secret once. Store it in a server-side
secret manager or environment variable; the database stores only its SHA-256
digest. Token metadata can be listed with `GET /api/auth/tokens`, and a token can
be revoked with `DELETE /api/auth/tokens/:tokenId`, both using the normal login
JWT.

Configure the MCP client to send the generated value on every request:

```text
Authorization: Bearer cfacct_...
```

The MCP exposes schema description, currency, account, transaction, balance
assertion, and ledger-verification tools. Each accounting result includes a
small Schema Semantic Compiler projection for the tables and fields used by
that operation. `describe_accounting_schema` accepts natural language and can
retrieve a relevant projection before another tool is selected.

`create_currency` creates private currencies, crypto assets, securities,
commodities, and custom units. Global catalog rows have no owner; authenticated
users see those rows plus only their own units. A unit's integer `scale` must be
chosen before amounts are recorded and must not later be reinterpreted.

`import_account_tree` accepts optional user-owned currency definitions followed
by up to 1,000 accounts with colon-delimited full names, normalized account
types, currency codes, descriptions, and placeholder flags. It validates
without writing by default. After reviewing the dry-run, repeat the same call
with `dry_run: false`; currencies and accounts are created in one transaction,
parents are ordered automatically, and exact matching definitions and paths
make retries idempotent.

Timestamped security, mutual-fund, commodity, and FX price history belongs in
owned `xrates` rows with `xrate_type = 'reference'`. Posted accounting continues
to use only the exact `transaction` rate copied into each transaction.

### Deployment order

1. Install the pinned dependencies from `package-lock.json`.
2. Create and verify a recoverable database backup.
3. Stop API writers and apply all pending migrations through 0008 with `ACCOUNTING_MIGRATION_BACKUP_CONFIRMED=1 npm run schema:migrate`.
4. Run `npm run schema:verify`, then restart the API service.

`schema:semantics:sync` is a development command that rewrites the tracked
semantic form from a migrated development database. Do not run it in a
production checkout during deployment; production verifies the committed form
with `schema:verify` instead.
