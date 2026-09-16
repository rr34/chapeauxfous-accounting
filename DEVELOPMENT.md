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

After the backup has printed `Verified recoverable backup`, continue with
**Production deployment** below. That is the single authoritative production
migration procedure. In particular, do not run `schema:semantics:sync` in a
production checkout.

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
referenced record in tool text. Recoverable MCP errors and incomplete
workflows use the authoritative `agent-slayer.retry-descriptor` version-1
field contract.

Every discovered tool also publishes `_meta["agent-slayer/selection"]` using
the Agent Slayer Tool Description version-1 contract. Its concise, validated
routing summary and action/effect classifications let orientation select an
Accounting tool before receiving the tool's full execution description and
schemas. Keep the routing summary specific to the domain outcome; an exchange
name in a ledger account does not require an exchange integration to read that
account through `list_accounts`.

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
exact commit tool and plan ID in `nextAction.onApproval`. After the user confirms that exact preview,
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
there are no rejections—a durable `importPlanId`. After explicit confirmation,
`commit_transaction_import` accepts only that ID, revalidates the batch, and
atomically creates all planned transactions. Identical confirmation retries
return the stored commit result. `get_transaction_import_plan` reports ready,
expired, invalidated, or committed state across MCP connections, including the
preview digest, expiration, compact summary, and stored commit result. Expired,
committed, and invalidated plans become eligible for owner-scoped cleanup 48
hours after their expiration or terminal timestamp.

For the durable source-file workflow, call `get_transaction_import_schema`,
create one job with `create_transaction_import_job`, and preserve its
`import_job_id`, source-system namespace, original source-file SHA-256, and
final expected canonical-record count for the entire import. The LLM may inspect
representative source samples and define a declarative mapping, but ordinary
parser code must apply that mapping to the complete source file. Accounting
does not parse CSV and the LLM must not reproduce the complete transformed
dataset.

The parser persists file-originated output as UTF-8 canonical JSON Lines with
media type `application/x-ndjson`: each nonblank line is one object conforming
to the authoritative canonical line-record JSON Schema. JSON Lines changes
only the packaging, not the canonical record model. It is the artifact format
for file-originated and unusually large generated input. Direct, bounded
transactions may continue to use ordinary JSON tool arguments.

`stage_transaction_import_artifact` mechanically activates the transfer by
publishing `_meta["agent-slayer/artifactUpload"]` with contract version 1,
transport ID `transaction_import`, endpoint `/mcp/artifacts`, accepted media
type `application/x-ndjson`, a 1 MiB maximum chunk, and the MCP server's maximum
artifact size. Using the same Accounting API bearer token, the host:

1. sends `POST /mcp/artifacts` with a stable `client_request_id`, `file_name`,
   `media_type`, `byte_size`, and whole-file `sha256`;
2. resumes at the returned `next_offset` and sends raw chunks of at most 1 MiB
   to `PATCH /mcp/artifacts/{artifact_id}` with `Content-Type:
   application/octet-stream`, `Upload-Offset`, and `X-Content-SHA256` headers;
   Accounting verifies each chunk checksum before appending those bytes;
3. calls `POST /mcp/artifacts/{artifact_id}/complete`, which succeeds only after
   Accounting verifies the complete byte count and whole-file SHA-256, then
   verifies with `GET` that the root response contains
   the original `artifact_id`, `status: complete`, final `next_offset`,
   `media_type`, `byte_size`, and `sha256`; and
4. calls `stage_transaction_import_artifact` with only the logical
   `import_job_id` and verified `artifact_id`.

The byte chunks are host-managed transport and never enter model context.
Accounting stores upload bytes and small JSON sidecars in an owner-scoped
filesystem spool, not in MariaDB. Set `ACCOUNTING_ARTIFACT_ROOT` to an absolute
durable path in production; it defaults to `api/data/artifacts` locally. The
confirmed resumable offset is always derived from the actual stored file size,
completion atomically promotes the verified partial file, and the sidecar
binds a completed artifact to no more than one import job. The API service user
must have exclusive read/write access to this directory, and it should be
included in operational backups while imports are in progress.

Transaction-import job tools return compact control state—job and artifact
identifiers, progress, exceptions, preview, and commit results—without
repeating the database schema-semantic projection on every workflow call. The
agent fetches the authoritative canonical schema once with
`get_transaction_import_schema`; the owner-scoped job resource remains
available when its database projection is specifically needed.

Accounting waits for the complete verified artifact, groups records across the
whole file by stable transaction external ID, validates accounts, currencies,
decimals, exchange rates, and balance, deduplicates, and applies internal
idempotent batches. Invalid transactions remain structured exceptions without
aborting valid transactions. The LLM pages only those exceptions and presents
the final MCP preview before explicit commit. Retrying the artifact stage
or a corrected exception never requires resubmitting successful records.

`stage_transaction_import_chunk` remains the ordinary JSON path for bounded
direct input, with at most 10,000 canonical line records per call. The MCP route
has a 16 MB JSON body allowance for those calls; other ordinary API routes
retain their 2 MB limit. Artifact upload accepts files through 64 MiB without
placing those bytes in an MCP JSON tool argument.

New registrations create only the user identity and begin with an empty chart
of accounts. Clicking an account in the web client opens its editor; the
permanent-delete action is kept inside that modal. Only an empty leaf account
can be deleted, so accounts with children, transaction lines, or balance
assertions must have those references resolved first. Currency changes and
conversion to a placeholder are also blocked once native-unit amounts or
balance assertions depend on the account.

The MCP exposes the same account update service as the HTTP adapter. Permanent
MCP deletion is an MCP-owned workflow: `preview_delete_account` verifies an
owner-scoped account is an empty, unreferenced leaf and saves a durable
15-minute plan; after explicit confirmation, `commit_delete_account` locks and
revalidates that exact plan, deletes atomically, verifies the account is absent,
and returns a receipt. `get_account_delete_plan` reads its durable status.

Timestamped security, mutual-fund, commodity, and FX price history belongs in
owned `xrates` rows with `xrate_type = 'reference'`. Posted accounting continues
to use only the exact `transaction` rate copied into each transaction.

### Multi-statement and crypto reconciliation

Use `save_balance_assertion` to record the exact opening and closing native-unit
balances shown by every statement in a reconciliation set. The opening assertion
is the end-of-day balance immediately before the import interval; the closing
assertion is the final end-of-day balance. Then call
`get_statement_reconciliation_context` with all statement-backed account IDs and those
two dates. For each account it returns the statement-required normal movement,
the debit-positive movement already posted, and the exact remaining native-unit
movement that imported lines must supply. A missing assertion leaves that
account ungrounded rather than manufacturing a target.

Analyze related statements together before importing either one. Match transfer
counterparts using provider IDs, transaction hashes, timestamps, directions,
and quantities. Sent and received quantities need not match: preserve the exact
amount from each account's own statement and represent an evidenced difference
as a fee. Give the joined transaction a stable composite external ID and retain
each provider row ID as its line external ID. Use `import_transactions` for the
joined, complete transaction so the ordinary preview and explicit-confirmation
boundary still applies.

The extraction source may be CSV, PDF, OCR, or a screenshot. Normalize only the
visible facts into `analyze_statement_observations`: stable document and record
IDs, statement account, date or timestamp, signed native amount, description,
and a provider or blockchain reference when one is actually present. The server
converts decimals with the account's established scale, compiles existing-ledger
and overlapping-input duplicate candidates, ranks cross-statement transfer
counterparts, and compares proposed new observation totals with the balance
residual for every statement-backed account.

Only an exact stable source-reference, account, amount, and nearby-date match is
automatically excluded as an existing ledger duplicate. Equal account, amount,
and date without stable identity is deliberately a review candidate because
legitimate repeated payments exist. Source-reference conflicts block automatic
assembly. Reuse the same source document and record IDs whenever a file or image
is reprocessed.

For the final `import_transactions` preview, supply its `reconciliation` object
with the same statement-backed accounts and opening/closing dates. This is a
hard server-side gate: planned new line amounts must exactly equal each
account's remaining known-balance movement before a commit plan is created.
The commit re-reads those assertions and posted movements and invalidates the
plan if they changed. Duplicate and missing rows therefore cannot ordinarily be
hidden by making the journal entry balance only in its valuation currency.

If those checks still leave movement that is proven by the opening and closing
balances but whose category is unknown, it may be posted explicitly as a
balance-derived adjustment. The statement-account line uses the exact residual;
the counterline goes to a user-selected ordinary postable suspense account of
the same currency, such as `Ask Accountant` or `Ask Human`, and carries
`question` metadata. These accounts are not created automatically and must not
be placeholders. This closes the known balance while keeping the classification
uncertainty visible instead of inventing a source row or category.

`list_accounting_questions` returns those posted suspense lines. A receipt or
later human decision resolves one with `resolve_accounting_question`, which
reassigns only the suspense line to an active postable account of the same
currency. Its native amount and valuation value remain unchanged, so the
original transaction stays balanced and the already-proven statement-account
movement is not disturbed. Resolved question metadata remains attached for
audit and exact retries are idempotent. Older suspense lines can be enrolled
with `open_accounting_question`.

For a statement that authoritatively describes only one account, use
`import_single_account_statement` instead of asking the caller to construct the
unknown half of every journal entry. Select the statement account and one
ordinary, active, same-currency suspense account. Each source line becomes its
own balanced transaction: the source amount and value are copied unchanged to
the statement account and marked `cleared`; the exact opposite amount and value
go to the selected suspense account, remain `unreconciled`, and carry an open
accounting question. All unknown counterlines therefore collect in one bucket
without contaminating the authoritative account. Stable source IDs retain the
ordinary import idempotency guarantees, and screenshot or overlapping-file
imports still run through statement-observation duplicate analysis first.

After saving the closing balance assertion and committing the statement import,
`reconcile_account_through_date` compares that assertion with the posted normal
balance under row locks. It changes the selected account's lines through that
date to `reconciled` only on an exact native-unit match. The suspense lines live
in another account, so they remain open and may later be reclassified without
changing the reconciled side.

Every joined transaction has one valuation currency. A foreign line keeps its
actual native amount and separately carries its value in that valuation
currency. Prefer an explicit statement value. `create_reference_rate` and
`list_reference_rates` store and retrieve timestamped reference-only prices as
exact positive native-unit ratios when a transaction-time value must be derived.
Round a derived value once to the valuation currency's smallest unit. Reference
prices never post accounting automatically and never replace statement
quantities.

For crypto transfers, an asset-denominated network-fee account can retain both
the fee's native crypto quantity and its transaction-time fiat value. On a trade,
record disclosed provider fees first; infer spread or margin only from the
remaining fiat-value residual after the asset value and all explicit fees are
accounted for. This prevents the same economic cost from being counted twice.

## Schema semantics

`db/schema-semantics.json` is a tracked, reviewed build artifact. It covers the
public ledger schema plus the MCP-owned import-plan and resumable-import
workflow tables needed by exact MCP operation projections. Human-written
meanings live in that file; compiler-owned mechanics come from MariaDB.

Run `npm run schema:semantics:sync` only in a development checkout, against a
development database that already has every tracked migration applied. The
command deliberately rewrites `db/schema-semantics.json`, including its
`extractedAt` timestamp and JSON formatting. Review the resulting mechanics and
fill any new semantic blanks, run `npm run schema:verify`, and commit the
reviewed file with the code and migration that require it.

Production never generates or modifies the tracked semantic form. It consumes
the committed file and uses `npm run schema:verify` to prove that the migrated
production database matches it.

## Production deployment

The tracked semantic form includes `accounting_import_plans` as authoritative,
temporary, owner-scoped workflow state. Its raw payload, result, and hash fields
are private financial data excluded from generic search and ordinary context;
only exact MCP workflow projections may expose bounded validated results.

1. Install the pinned dependencies from `package-lock.json`.
2. Complete **Back up and prove the backup restores** above and retain both backup files.
3. Stop API writers.
4. Apply every pending tracked migration:

   ```bash
   ACCOUNTING_MIGRATION_BACKUP_CONFIRMED=1 npm run schema:migrate
   ```

5. Verify the migrated schema, committed semantic form, and posted ledger:

   ```bash
   npm run schema:verify
   ```

6. Restart the API service only after verification succeeds.

Never run `npm run schema:semantics:sync` during production deployment. If
`git status --short` reports a modified `db/schema-semantics.json` on a server,
inspect it, preserve a diagnostic diff outside the checkout if needed, and
restore the tracked file before pulling. Do not commit a production-generated
semantic form.
