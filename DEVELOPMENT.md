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

### Back up and prove the backup restores

Do this before applying migrations to any database that contains user data.
Run the commands from the repository root. Set the first three values to the
matching `MYSQL_*` values in `api/.env`; the commands deliberately prompt for
the password so it is not stored in shell history or exposed in the process
arguments.

Store the dump outside the Git checkout so a deployment cannot replace it:

```bash
db_host=127.0.0.1
db_user=nate
db_name=cfaccounting
backup_dir=/srv/backups/chapeauxfous-accounting

sudo install -d -m 700 -o "$(id -un)" -g "$(id -gn)" "$backup_dir"
backup_file="$backup_dir/$db_name-$(date -u +%Y%m%dT%H%M%SZ).sql"

mariadb-dump \
  --host="$db_host" \
  --user="$db_user" \
  --password \
  --single-transaction \
  --quick \
  --routines \
  --events \
  --triggers \
  --hex-blob \
  "$db_name" > "$backup_file"

test -s "$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256"
sha256sum --check "$backup_file.sha256"
```

A checksum and a nonempty file are not enough. Restore the dump into a new,
isolated database and compare its base-table count with the live database:

```bash
verify_db="${db_name}_backup_verify_$(date -u +%Y%m%d%H%M%S)"

mariadb --host="$db_host" --user="$db_user" --password \
  --execute="CREATE DATABASE \`$verify_db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

mariadb --host="$db_host" --user="$db_user" --password \
  "$verify_db" < "$backup_file"

live_table_count=$(mariadb --host="$db_host" --user="$db_user" --password \
  --batch --skip-column-names \
  --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$db_name' AND table_type = 'BASE TABLE'")

restored_table_count=$(mariadb --host="$db_host" --user="$db_user" --password \
  --batch --skip-column-names \
  --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$verify_db' AND table_type = 'BASE TABLE'")

test "$live_table_count" -gt 0
test "$restored_table_count" -eq "$live_table_count"

mariadb --host="$db_host" --user="$db_user" --password \
  --execute="DROP DATABASE \`$verify_db\`"

echo "Verified recoverable backup: $backup_file ($restored_table_count tables)"
```

Every command above must succeed. If the restore or comparison fails, do not
set the migration confirmation flag and do not migrate. Leave the isolated
verification database in place for diagnosis if failure occurs before its
`DROP DATABASE` command. The `.sql` file and its `.sha256` file are the backup;
keep both until the migrated application and ledger have been verified.

After the backup has printed `Verified recoverable backup`, run:

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

The MCP publishes its versioned capability manifest at
`accounting://manifest/capabilities/v1`. The manifest groups tools into stable
capabilities, declares dependencies and attachment guidance, and advertises the
bounded `accounting.currencies.active` and `accounting.accounts.active_paths`
context views. Every tool publishes an exact output schema and all four effect
annotations. Bounded read tools return completeness, count, continuation, and
stable source-reference metadata. Mutations return a server-issued receipt
binding the tool name to a SHA-256 digest of its exact arguments and the
observed entity references. Source references returned as MCP resource links
resolve through owner-scoped resource templates instead of duplicating the
referenced record in tool text. Recoverable provider errors and incomplete
workflows use the authoritative `agent-slayer.retry-descriptor` version-1
field contract.

`create_currency` creates private currencies, crypto assets, securities,
commodities, and custom units. Global catalog rows have no owner; authenticated
users see those rows plus only their own units. A unit's integer `scale` must be
chosen before amounts are recorded and must not later be reinterpreted. When
source data does not supply an exact scale, the agent must ask the user for each
unit's scale rather than guessing or proposing a default.

`import_account_tree` accepts optional user-owned currency definitions followed
by up to 1,000 accounts with colon-delimited full names, normalized account
types, currency codes, descriptions, and placeholder flags. It always runs the
complete batch as a dry run. File retries must contain the entire intended
batch, not only rows that previously failed. Call it even when a new currency's
scale or other definition fields are unknown. In that case it returns
`status: needs_input`, exact questions for the user, and a machine-readable
instruction to retry the complete batch. The result reports explicit
would-create and would-reuse counts, detailed planned rows, summaries by type,
currency, placeholder status, and top-level branch, plus a durable owner-scoped
`importPlanId`, `expiresAt`, a SHA-256 `previewDigest`, and a compact numerical
summary before the potentially large preview. The MCP advertises and validates
this result through a formal output schema. A successful response includes the
exact commit tool and plan ID in `nextAction.onApproval`. After the user approves that exact preview,
`commit_account_tree_import` accepts only the plan ID, revalidates current
database state, and atomically creates the currencies and accounts. Plans
expire after 24 hours, and repeated commit calls return the stored result
without duplicating ledger data. `get_account_tree_import_plan` retrieves ready,
committed, expired, or invalidated status across MCP connections and unrelated
requests. Missing, expired, invalidated, and inconsistent commit attempts return
machine-readable recovery instructions. An ID owned by someone else is reported
as not found so ownership is never disclosed.

`import_transactions` is the source-neutral transaction batch dry run. A batch
contains up to 250 complete transactions and 5,000 nested line items. A stable
`source_system` namespace plus each transaction's generic external ID provides
grouping, deduplication, conflict detection, and retry safety. Line items use
exact colon-delimited account paths and decimal amounts; the server resolves
the accounts, converts amounts through their established currency scales,
validates foreign values and exchange rates, and requires every transaction to
balance in its valuation currency. The dry-run result lists all unknown or
ambiguous paths, numerical create/reuse/reject counts, useful summaries, and—if
there are no rejections—a durable `importPlanId`. After explicit approval,
`commit_transaction_import` accepts only that ID, revalidates the batch, and
atomically creates all planned transactions. Identical confirmation retries
return the stored commit result. `get_transaction_import_plan` reports ready,
expired, invalidated, or committed state across MCP connections, including the
preview digest, expiration, compact summary, and stored commit result. Expired,
committed, and invalidated plans become eligible for owner-scoped cleanup 48
hours after their expiration or terminal timestamp.

The MCP accepts structured batches of at most 1,000 complete transactions and
10,000 nested line items; it does not parse CSV. The calling LLM converts source
rows into complete nested transactions. Larger datasets are split only between
transactions and use the same stable `source_system` and stable external IDs in
every batch. Each batch is previewed and explicitly confirmed in sequence, and
an approved plan is committed before the next batch is submitted. A retry or a
resumed dataset may safely repeat committed source IDs because matching content
is reused and conflicting content is rejected. The MCP route has a 16 MB JSON
body allowance for ordinary 1,000-transaction statement imports; other API
routes retain their 2 MB limit.

New registrations create only the user identity and begin with an empty chart
of accounts. Clicking an account in the web client opens its editor; the
permanent-delete action is kept inside that modal. Only an empty leaf account
can be deleted, so accounts with children, transaction lines, or balance
assertions must have those references resolved first. Currency changes and
conversion to a placeholder are also blocked once native-unit amounts or
balance assertions depend on the account.

The MCP exposes the same account update service as the HTTP adapter. Permanent
MCP deletion is a provider-owned workflow: `preview_delete_account` verifies an
owner-scoped account is an empty, unreferenced leaf and saves a durable
15-minute plan; after explicit approval, `commit_delete_account` locks and
revalidates that exact plan, deletes atomically, verifies the account is absent,
and returns a receipt. `get_account_delete_plan` reads its durable status.

Timestamped security, mutual-fund, commodity, and FX price history belongs in
owned `xrates` rows with `xrate_type = 'reference'`. Posted accounting continues
to use only the exact `transaction` rate copied into each transaction.

### Deployment order

The tracked semantic form includes `accounting_import_plans` as authoritative,
temporary, owner-scoped workflow state. Its raw payload, result, and hash fields
are private financial data excluded from generic search and ordinary context;
only exact provider workflow projections may expose bounded validated results.

1. Install the pinned dependencies from `package-lock.json`.
2. Complete **Back up and prove the backup restores** above and retain both backup files.
3. Stop API writers and apply all pending migrations through 0011 with `ACCOUNTING_MIGRATION_BACKUP_CONFIRMED=1 npm run schema:migrate`.
4. Run `npm run schema:verify`, then restart the API service.

`schema:semantics:sync` is a development command that rewrites the tracked
semantic form from a migrated development database. Do not run it in a
production checkout during deployment; production verifies the committed form
with `schema:verify` instead.
