-- Chapeaux Fous Accounting MariaDB migration ledger.
--
-- Add new migrations directly below this header, newest first. The runner
-- validates newest-first file order and applies pending migrations oldest first.
-- Marker format:
--   -- migration 0006: short-description
--   <schema and data SQL>
--   -- end migration 0006

-- migration 0018: designate-suspense-accounts
-- writer downtime: schedule maintenance; adding an account column takes a metadata lock.
-- deployment order: apply before deploying code that reads or writes is_suspense.
-- recovery: restore the verified pre-migration backup if rollback is required.
-- Existing accounts remain ordinary until their owner explicitly marks one.

ALTER TABLE `accounts`
  ADD COLUMN `is_suspense` tinyint(1) NOT NULL DEFAULT 0
    COMMENT 'Whether the owner designated this active, postable account as the holding account for unresolved imported counterlines in its native currency. Format: Boolean: 0 is ordinary and 1 is suspense. Rules: Application code permits at most one active suspense account per owner and currency; the user chooses the account.'
    AFTER `is_placeholder`;

-- end migration 0018

-- migration 0017: store-optional-transaction-utc-timestamp
-- writer downtime: schedule maintenance; adding a transaction column takes a metadata lock.
-- deployment order: apply before deploying code that reads or writes TransactionAtUtc.
-- recovery: restore the verified pre-migration backup if rollback is required.
-- Existing transactions have no asserted source instant, so leave the new field NULL.

ALTER TABLE `transactions`
  ADD COLUMN `TransactionAtUtc` datetime(3) NULL DEFAULT NULL
    COMMENT 'Optional exact UTC instant supplied by the source when meaningful. Format: UTC date-time with millisecond precision; null when only the accounting date is known. Rules: TransactionDate remains the ledger ordering and reconciliation date.'
    AFTER `TransactionDate`;

-- end migration 0017

-- migration 0016: document-accounting-storage
-- writer downtime: schedule maintenance; altering comments takes metadata locks on ledger tables.
-- deployment order: apply before relying on describe_accounting_schema for full storage comments.
-- recovery: restore the verified pre-migration backup if rollback is required.
-- Metadata only: table and column comments carry the reviewed storage meanings.
-- MODIFY COLUMN repeats the existing column definition to set its COMMENT;
-- this block adds no columns, indexes, constraints, or data writes.
-- The runner holds one connection for this block. Preserve its foreign-key-check
-- setting while documenting existing referenced columns without changing data.

SET @accounting_previous_fk_checks = @@SESSION.foreign_key_checks;
SET SESSION foreign_key_checks = 0;

ALTER TABLE `account_balance_assertions`
  COMMENT='Store user-entered end-of-day balances used to reconcile the derived ledger. One row: One account''s known balance at the end of one calendar date. Rules: The known balance is expressed in the account currency''s smallest native units. There is at most one assertion per account and balance date.',
  MODIFY COLUMN `account_balance_assertion_id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier for the balance assertion.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose ledger owns this balance assertion.',
  MODIFY COLUMN `account_id` int(11) NOT NULL COMMENT 'Account whose balance is being asserted.',
  MODIFY COLUMN `balance_date` date NOT NULL COMMENT 'Calendar date whose end-of-day balance is known. Format: YYYY-MM-DD accounting calendar date without a time zone',
  MODIFY COLUMN `known_balance_units` bigint(20) NOT NULL COMMENT 'Signed known balance in the account currency''s smallest native units. Units: Signed integer native units interpreted using the referenced account currency''s scale. Format: base-10 integer';

ALTER TABLE `accounting_import_plans`
  COMMENT='Store durable owner-scoped provider plans that bind an approved preview to one exact account-tree import, transaction import, account deletion, or transaction-deletion commit. One row: One temporary authoritative workflow plan that records the exact validated input, preview binding, lifecycle state, and optional commit result. Rules: A ready, unexpired, owner-scoped plan is the authoritative record permitting its exact provider commit; there is no separate commit-authorization record. Plans and their fields may be read only through owner-scoped provider workflow tools and stable plan references. Raw payload_json, result_json, and hash values are never generic search evidence or ordinary context; tools may return only exact bounded projections defined by their output schemas. Only import_plan_id, owner_person_id for server-side isolation, import_kind, plan_status, source_system, and lifecycle timestamps are queryable or filterable. JSON and hash fields are not searchable. A plan is eligible for pruning 48 hours after it expires, commits, or is invalidated.',
  MODIFY COLUMN `import_plan_id` char(36) NOT NULL COMMENT 'Opaque stable provider identifier that binds status reads and a later commit to this exact plan. Format: UUID string Rules: Never infer, alter, or reuse this identifier for a different workflow.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose accounting workflow owns this plan and is the only person allowed to read or commit it. Rules: Use only for server-side authorization and isolation.',
  MODIFY COLUMN `import_kind` enum('account_tree','transactions','account_delete','transaction_delete','import_restart','user_delete') NOT NULL COMMENT 'Closed provider workflow family whose exact preview and commit contract owns this plan. Rules: Only the matching workflow''s status and commit services may consume the row. Values: account_tree: A complete account-tree import plan. transactions: A complete transaction-batch import plan. account_delete: A verified single-account permanent-deletion plan. transaction_delete: A verified permanent-deletion plan bound to an exact transaction set. import_restart: A verified plan that removes one import job and only the ledger transactions that job created. user_delete: A password-verified plan that permanently removes one user and all accounting data they own.',
  MODIFY COLUMN `plan_status` enum('ready','committed','invalidated') NOT NULL COMMENT 'Stored workflow state; expiration is derived separately by comparing expires_at with the current UTC time. Rules: An expired plan remains stored as ready but is reported as expired by the provider. Values: ready: The exact plan may be committed if it is unexpired and passes revalidation. committed: The exact plan completed and its bounded result was stored. invalidated: The plan can no longer be committed and a new preview is required.',
  MODIFY COLUMN `source_system` varchar(32) NULL DEFAULT NULL COMMENT 'Optional external-system namespace for a transaction import; null for workflows that do not use a source namespace. Rules: May be filtered only within the authenticated owner''s plans.',
  MODIFY COLUMN `payload_sha256` char(64) NOT NULL COMMENT 'Integrity digest of the exact normalized payload_json stored for commit revalidation. Format: lowercase hexadecimal SHA-256 Rules: Not searchable or filterable; a mismatch invalidates the plan.',
  MODIFY COLUMN `preview_sha256` char(64) NOT NULL COMMENT 'Digest binding the provider''s validated preview to the durable plan reported for confirmation. Format: lowercase hexadecimal SHA-256 Rules: May be returned by exact plan tools but is not searchable or filterable.',
  MODIFY COLUMN `payload_json` longtext NOT NULL COMMENT 'Exact normalized private financial input that the provider revalidates and applies during commit. Format: JSON encoded with the owning workflow''s versioned internal shape Rules: Never expose the raw value through generic search, schema description results, context views, or ordinary model context.',
  MODIFY COLUMN `summary_json` longtext NOT NULL COMMENT 'Compact numerical preview summary stored for bounded status reads and confirmation reporting. Format: JSON object with the owning workflow''s exact summary schema Rules: Only exact owner-scoped plan tools may return its validated bounded projection; the raw database field is not searchable.',
  MODIFY COLUMN `expires_at` datetime(6) NOT NULL COMMENT 'UTC instant after which the plan cannot be committed and is reported as expired. Format: UTC date-time with microsecond precision Rules: An expired plan is eligible for pruning 48 hours after this instant.',
  MODIFY COLUMN `committed_at` datetime(6) NULL DEFAULT NULL COMMENT 'UTC instant when this exact plan successfully committed, or null before commitment. Format: UTC date-time with microsecond precision Rules: A committed plan is eligible for pruning 48 hours after this instant.',
  MODIFY COLUMN `invalidated_at` datetime(6) NULL DEFAULT NULL COMMENT 'UTC instant when integrity or database-state revalidation made this plan unusable, or null while it remains valid or committed. Format: UTC date-time with microsecond precision Rules: An invalidated plan is eligible for pruning 48 hours after this instant.',
  MODIFY COLUMN `invalidation_code` varchar(64) NULL DEFAULT NULL COMMENT 'Stable provider reason code explaining why a plan was invalidated, or null if it was not invalidated. Format: uppercase machine-readable provider code Rules: The owning workflow defines the code; clients must not infer uncontracted behavior from its spelling.',
  MODIFY COLUMN `result_json` longtext NULL DEFAULT NULL COMMENT 'Stored bounded provider result for a successful commit, used to make repeated commit calls idempotent. Format: JSON object with the owning workflow''s exact committed-result schema Rules: Never expose the raw field through generic search; exact owner-scoped workflow tools may return only its validated bounded projection.',
  MODIFY COLUMN `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC instant when the provider persisted the validated preview plan. Format: UTC date-time with microsecond precision Rules: May be used with owner_person_id for server-side lifecycle inspection.';

ALTER TABLE `accounting_schema_metadata`
  COMMENT='Track the singleton version and latest completed block of the append-only Accounting migration ledger.',
  MODIFY COLUMN `singleton` tinyint(3) unsigned NOT NULL COMMENT 'Fixed singleton key for the one schema-version record.',
  MODIFY COLUMN `schema_version` int(10) unsigned NOT NULL COMMENT 'Number of the latest migration block completed by the runner.',
  MODIFY COLUMN `last_migration` varchar(160) NOT NULL COMMENT 'Label of the latest migration block completed by the runner.',
  MODIFY COLUMN `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT 'UTC time the migration runner last advanced the recorded version.';

ALTER TABLE `accounting_transaction_import_items`
  COMMENT='Store each transaction group and its complete canonical context, validation outcome, and optional ledger identity within a resumable import job. One row: One source transaction external ID grouped from one or more canonical line records in one logical import job. Rules: The composite key makes each transaction external ID unique within a job. Exceptions retain complete canonical transaction context and do not invalidate successful groups.',
  MODIFY COLUMN `import_job_id` char(36) NOT NULL COMMENT 'Opaque stable identifier of the owner-scoped logical transaction import job. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `transaction_external_id` varchar(128) NOT NULL COMMENT 'Stable source transaction identifier within source_system and this job. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `canonical_sha256` char(64) NOT NULL COMMENT 'Integrity digest of the complete grouped canonical transaction context. Format: lowercase hexadecimal SHA-256 Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `canonical_json` longtext NOT NULL COMMENT 'Exact canonical line records grouped for the transaction, retained for validation and exception correction. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `resolved_json` longtext NULL DEFAULT NULL COMMENT 'Provider-resolved accounting representation for a valid staged or reused transaction. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `source_record_count` int(10) unsigned NOT NULL COMMENT 'Immutable number of original source records represented by this transaction group, independent of accounting lines added or removed during exception correction. Rules: Use only within the authenticated owner-scoped provider workflow. Exception correction may change canonical accounting line count without changing this original-source reconciliation count.',
  MODIFY COLUMN `item_status` enum('staged','reused','exception','committed','deleted') NOT NULL COMMENT 'Provider-owned outcome for this transaction group: staged, reused, exception, committed, or explicitly deleted later. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `ledger_transaction_id` bigint(20) NULL DEFAULT NULL COMMENT 'Optional owner-scoped ledger transaction created or reused by this import group. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `errors_json` longtext NULL DEFAULT NULL COMMENT 'Structured provider validation exceptions and any explicit user exclusion disposition for this complete canonical transaction context. Rules: Use only within the authenticated owner-scoped provider workflow. A USER_EXCLUDED entry records the user''s reason and decision time without discarding the original validation errors.',
  MODIFY COLUMN `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC instant when this provider-owned row was created. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC instant of the latest provider-owned change to this row. Rules: Use only within the authenticated owner-scoped provider workflow.';

ALTER TABLE `accounting_transaction_import_jobs`
  COMMENT='Own one durable, resumable, source-neutral transaction import from source-file identity through explicit preview and commit. One row: One owner-scoped logical import job with a stable source identity, final expected record count, lifecycle state, and optional committed result. Rules: The expected record count and source identity are immutable after creation. A job is committed only after all expected records reconcile and the exact preview is explicitly committed.',
  MODIFY COLUMN `import_job_id` char(36) NOT NULL COMMENT 'Opaque stable identifier of the owner-scoped logical transaction import job. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose private ledger owns this import job. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `client_request_id` varchar(128) NOT NULL COMMENT 'Stable caller-supplied idempotency key for creating the logical job. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `source_system` varchar(32) NOT NULL COMMENT 'Stable external-system namespace used with transaction and optional line external IDs for deduplication. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `source_file_sha256` char(64) NOT NULL COMMENT 'SHA-256 identity of the complete source file represented by this logical job. Format: lowercase hexadecimal SHA-256 Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `source_file_name` varchar(1024) NULL DEFAULT NULL COMMENT 'Optional informational source filename; it is not the source-file identity. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `expected_record_count` bigint(20) unsigned NOT NULL COMMENT 'Final number of canonical source line records expected across every chunk and correction. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `job_status` enum('receiving','review_ready','committed') NOT NULL DEFAULT 'receiving' COMMENT 'Provider-owned lifecycle state of the logical import job. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `preview_sha256` char(64) NULL DEFAULT NULL COMMENT 'Digest binding the latest complete provider preview to its explicit commit. Format: lowercase hexadecimal SHA-256 Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `result_json` longtext NULL DEFAULT NULL COMMENT 'Stored bounded final job summary used for idempotent commit replay. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `committed_at` datetime(6) NULL DEFAULT NULL COMMENT 'UTC instant when the entire logical import job committed. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC instant when this provider-owned row was created. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC instant of the latest provider-owned change to this row. Rules: Use only within the authenticated owner-scoped provider workflow.';

ALTER TABLE `accounting_transaction_import_requests`
  COMMENT='Record stable idempotency receipts for each import chunk and corrected-exception retry. One row: One named request payload accepted for one import job and request kind. Rules: Reusing a request ID with a different payload digest is rejected. Replaying the same request ID and payload is side-effect free.',
  MODIFY COLUMN `import_job_id` char(36) NOT NULL COMMENT 'Opaque stable identifier of the owner-scoped logical transaction import job. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `request_kind` enum('chunk','exception_retry') NOT NULL COMMENT 'Whether this idempotency receipt covers a normal chunk or a corrected exception retry. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `request_id` varchar(128) NOT NULL COMMENT 'Stable caller-supplied idempotency key within one job and request kind. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `payload_sha256` char(64) NOT NULL COMMENT 'Integrity digest binding this request ID to its exact canonical payload. Format: lowercase hexadecimal SHA-256 Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `record_count` int(10) unsigned NOT NULL COMMENT 'Number of canonical source records carried by this accepted request payload. Rules: Use only within the authenticated owner-scoped provider workflow.',
  MODIFY COLUMN `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC instant when this provider-owned row was created. Rules: Use only within the authenticated owner-scoped provider workflow.';

ALTER TABLE `api_tokens`
  COMMENT='Store revocable owner-scoped bearer credentials for Accounting API and MCP clients.',
  MODIFY COLUMN `api_token_id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier for this credential record.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose Accounting API access this credential authorizes.',
  MODIFY COLUMN `token_name` varchar(128) NOT NULL COMMENT 'User-facing label for identifying and revoking this credential.',
  MODIFY COLUMN `token_prefix` varchar(20) NOT NULL COMMENT 'Non-secret prefix shown when listing tokens.',
  MODIFY COLUMN `token_hash` binary(32) NOT NULL COMMENT 'SHA-256 of a 256-bit random bearer token; the plaintext token is not stored.',
  MODIFY COLUMN `expires_at` datetime(6) NULL DEFAULT NULL COMMENT 'UTC expiration time, or null for a token without a scheduled expiration.',
  MODIFY COLUMN `last_used_at` datetime(6) NULL DEFAULT NULL COMMENT 'UTC time this credential was last accepted, or null if never used.',
  MODIFY COLUMN `revoked_at` datetime(6) NULL DEFAULT NULL COMMENT 'UTC time this credential was revoked, or null while active.',
  MODIFY COLUMN `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC time this credential was created.';

ALTER TABLE `accounts`
  COMMENT='Store the user-defined accounts that receive double-entry line items. One row: One account belonging to one person''s ledger. Rules: Every account has an explicitly chosen type and currency. New users begin with no accounts; there is no implied root account or base currency. Only posted transaction line items contribute to displayed balances. Placeholder accounts organize the hierarchy and cannot receive transaction line items or balance assertions.',
  MODIFY COLUMN `account_id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier for the account.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose ledger owns the account.',
  MODIFY COLUMN `AccountName` text NOT NULL COMMENT 'Human-facing local account name within its parent.',
  MODIFY COLUMN `description` text NULL DEFAULT NULL COMMENT 'Optional human-facing explanation of the account''s purpose.',
  MODIFY COLUMN `is_placeholder` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Whether the account is an organizational placeholder that cannot receive postings. Format: Boolean: 0 is postable and 1 is a placeholder. Rules: Placeholder accounts cannot receive transaction line items or balance assertions. Values: 0: Ordinary postable account. 1: Non-postable placeholder account.',
  MODIFY COLUMN `parent_account_id` int(11) NULL DEFAULT NULL COMMENT 'Optional parent account in the same user''s account hierarchy.',
  MODIFY COLUMN `AccountType` enum('asset','liability','income','expense','equity') NOT NULL COMMENT 'Accounting classification controlling the account''s role: asset, liability, income, expense, or equity.',
  MODIFY COLUMN `account_currency_id` int(11) NOT NULL COMMENT 'Currency in whose native units every line item posted to this account is stored.',
  MODIFY COLUMN `archived_at` datetime NULL DEFAULT NULL COMMENT 'Time the account was archived; null means active.',
  MODIFY COLUMN `source_system` varchar(32) NULL DEFAULT NULL COMMENT 'Optional external system namespace used for idempotent imports.',
  MODIFY COLUMN `source_id` varchar(128) NULL DEFAULT NULL COMMENT 'Optional identifier within source_system used for idempotent imports.';

ALTER TABLE `currencies`
  COMMENT='Define global and user-owned currencies, securities, commodities, and custom units with the scale used to interpret integer native amounts. One row: One globally available or user-owned accounting unit. Rules: Amounts are stored as integers; divide by 10 raised to scale only for human display. A NULL owner_person_id identifies a global catalog row; a non-NULL owner identifies a private user-created unit. The application stores zero in scope_owner_person_id for global units and the owner person identifier for private units. A unit''s scale must not change after accounting amounts reference it.',
  MODIFY COLUMN `currency_id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier referenced by accounts, transactions, and exchange rates.',
  MODIFY COLUMN `owner_person_id` int(11) NULL DEFAULT NULL COMMENT 'Person who owns this private unit; NULL identifies a globally available catalog unit. Rules: Users may access global units and units bearing their own person identifier, never another user''s private units.',
  MODIFY COLUMN `CurrencyAbbreviation` varchar(50) NOT NULL COMMENT 'Human-facing currency code or unit abbreviation.',
  MODIFY COLUMN `display_name` varchar(255) NOT NULL COMMENT 'Full human-facing name for the currency, security, commodity, or custom unit.',
  MODIFY COLUMN `currency_type` enum('iso_4217','crypto','security','commodity','custom') NOT NULL DEFAULT 'iso_4217' COMMENT 'Semantic class of accounting unit, distinguishing ISO 4217 currencies, crypto assets, securities, commodities, and custom units. Values: iso_4217: System-defined ISO 4217 currency or official unit-of-account code. crypto: Cryptocurrency or a native subdivision of one. security: Stock, mutual fund, exchange-traded fund, or another security measured in shares. commodity: Physical or financial commodity measured in its native quantity. custom: User-defined accounting unit not covered by the other classes.',
  MODIFY COLUMN `scale` tinyint(3) unsigned NOT NULL DEFAULT 2 COMMENT 'Count of decimal places used to display one integer native-unit amount.',
  MODIFY COLUMN `scope_owner_person_id` int(11) NOT NULL DEFAULT 0 COMMENT 'Stored uniqueness scope: zero for global units and owner_person_id for private units. Rules: The application maintains this implementation field when it creates a private unit; it enforces per-owner code uniqueness and is not user input.';

ALTER TABLE `line_items`
  COMMENT='Store the signed account postings that make up double-entry transactions. One row: One signed posting to one account within one transaction. Rules: amount_units is a signed integer in the referenced account''s currency. value_units is the signed value in the containing transaction''s valuation currency; with nonzero amount and value it determines this line''s implied exchange rate, while zero value may record a quantity-only adjustment. Every transaction requires at least two line items, except that a zero-value quantity adjustment may contain one foreign-currency line with a nonzero amount and zero value. The application centrally validates that transaction values sum exactly to zero in the valuation currency.',
  MODIFY COLUMN `line_item_id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier for the posting.',
  MODIFY COLUMN `transaction_id` bigint(20) NOT NULL COMMENT 'Transaction containing this posting.',
  MODIFY COLUMN `amount_units` bigint(20) NOT NULL COMMENT 'Signed integer amount in the referenced account''s smallest native currency units. Units: Signed integer native units interpreted using the referenced account currency''s scale. Format: base-10 integer',
  MODIFY COLUMN `value_units` bigint(20) NULL DEFAULT NULL COMMENT 'Signed value of this posting in the containing transaction''s valuation currency. Units: Signed integer valuation units interpreted using the transaction valuation currency''s scale. Format: base-10 integer Rules: For native-currency lines this equals amount_units. For foreign-currency lines with nonzero amount and value, their ratio is the line''s exchange rate. A foreign-currency line with a nonzero amount and zero value is a quantity-only adjustment and has no exchange rate.',
  MODIFY COLUMN `memo` text NULL DEFAULT NULL COMMENT 'Optional explanation specific to this posting.',
  MODIFY COLUMN `account_id` int(11) NOT NULL COMMENT 'Account receiving this posting.',
  MODIFY COLUMN `reconciliation_state` enum('unreconciled','cleared','reconciled') NOT NULL DEFAULT 'unreconciled' COMMENT 'Whether the posting is unreconciled, cleared, or reconciled.',
  MODIFY COLUMN `reconciled_at` date NULL DEFAULT NULL COMMENT 'Calendar date on which the posting was reconciled, when applicable.',
  MODIFY COLUMN `source_id` varchar(128) NULL DEFAULT NULL COMMENT 'Optional source identifier unique within the containing transaction.';

ALTER TABLE `lineitems_tags_join`
  COMMENT='Associate reusable user-owned tags with transaction line items. One row: One association between one line item and one tag. Rules: Deleting a line item or tag deletes its associations.',
  MODIFY COLUMN `tagged_line_item_id` bigint(20) NOT NULL COMMENT 'Line item receiving the tag.',
  MODIFY COLUMN `tag_id` int(11) NOT NULL COMMENT 'Tag assigned to the line item.';

ALTER TABLE `people2_people`
  COMMENT='Store minimal local identity and password-verifier data for Accounting owners.',
  MODIFY COLUMN `person_id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Stable local person identifier used to scope owned Accounting records.',
  MODIFY COLUMN `Name` varchar(100) NOT NULL COMMENT 'Human-facing name for this person.',
  MODIFY COLUMN `OwnerEmail` varchar(255) NOT NULL COMMENT 'Unique email identifier used for local account sign-in.',
  MODIFY COLUMN `OwnerPasscode` varchar(255) NOT NULL COMMENT 'Scrypt password hash used to verify sign-in; never plaintext.',
  MODIFY COLUMN `EnteredAt` datetime(6) NOT NULL DEFAULT current_timestamp(6) COMMENT 'UTC time this local person record was created.',
  MODIFY COLUMN `UpdatedAt` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT 'UTC time this local person record was last changed.';

ALTER TABLE `tags`
  COMMENT='Store reusable key-value labels owned by one user for classifying line items. One row: One unique tag key and value in one person''s ledger. Rules: A key-value pair is unique within one person''s ledger.',
  MODIFY COLUMN `tag_id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier for the tag.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose ledger owns the tag.',
  MODIFY COLUMN `tag_key` varchar(50) NOT NULL COMMENT 'Normalized tag category key.',
  MODIFY COLUMN `tag_value` text NOT NULL COMMENT 'Human-facing value within the tag key.';

ALTER TABLE `transactions`
  COMMENT='Store double-entry accounting transaction headers and lifecycle state. One row: One dated accounting event composed of two or more signed line items. Rules: Posted transactions must balance exactly to zero in valuation_currency_id. A transaction and all accounts it uses must belong to the same person. Draft, posted, and voided are explicit states; posted is never inferred from dates.',
  MODIFY COLUMN `transaction_id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier for the transaction.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose ledger owns the transaction.',
  MODIFY COLUMN `EnteredAt` datetime NOT NULL DEFAULT current_timestamp() COMMENT 'Time the transaction row was first recorded.',
  MODIFY COLUMN `UpdatedAt` datetime NULL DEFAULT current_timestamp() ON UPDATE CURRENT_TIMESTAMP() COMMENT 'Time the transaction row was last changed.',
  MODIFY COLUMN `description` text NULL DEFAULT NULL COMMENT 'Optional human explanation of the complete transaction.',
  MODIFY COLUMN `valuation_currency_id` int(11) NOT NULL COMMENT 'Currency in which the signed line-item values must sum exactly to zero.',
  MODIFY COLUMN `TransactionState` enum('draft','posted','voided') NOT NULL DEFAULT 'draft' COMMENT 'Lifecycle state: draft, posted, or voided.',
  MODIFY COLUMN `TransactionDate` date NOT NULL COMMENT 'Accounting calendar date of the transaction. Format: YYYY-MM-DD accounting calendar date without a time zone',
  MODIFY COLUMN `reversal_of_transaction_id` bigint(20) NULL DEFAULT NULL COMMENT 'Optional earlier transaction reversed by this transaction.',
  MODIFY COLUMN `source_system` varchar(32) NULL DEFAULT NULL COMMENT 'Optional external system namespace used for idempotent imports.',
  MODIFY COLUMN `source_id` varchar(128) NULL DEFAULT NULL COMMENT 'Optional identifier within source_system used for idempotent imports.',
  MODIFY COLUMN `source_fingerprint` char(64) NULL DEFAULT NULL COMMENT 'SHA-256 fingerprint of normalized imported transaction content used to reject conflicting retries. Format: lowercase hexadecimal SHA-256 Rules: Matching source identifiers may be reused only when this fingerprint also matches.';

ALTER TABLE `xrates`
  COMMENT='Store exact rational exchange rates for transactions plus timestamped reference rates such as security and mutual-fund market prices. One row: One exact ratio converting positive source units to positive target units. Rules: Transaction rates use positive integer ratios rather than floating-point decimals. Convert a signed from-currency amount to target native units by multiplying by to_units and dividing by from_units. Each foreign account currency used by a transaction needs exactly one rate into its valuation currency. Reference rates never determine posted accounting values unless explicitly copied into a transaction rate.',
  MODIFY COLUMN `xrate_id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Stable identifier for the exchange rate.',
  MODIFY COLUMN `owner_person_id` int(11) NOT NULL COMMENT 'Person whose ledger owns the rate.',
  MODIFY COLUMN `xrate_type` enum('transaction','reference') NOT NULL DEFAULT 'reference' COMMENT 'Whether the rate is attached to a transaction or is reference-only.',
  MODIFY COLUMN `ValidAt` datetime NULL DEFAULT NULL COMMENT 'UTC time at which a reference rate applies; null for transaction rates.',
  MODIFY COLUMN `transaction_id` bigint(20) NULL DEFAULT NULL COMMENT 'Transaction using this exact rate; null for reference rates.',
  MODIFY COLUMN `from_units` bigint(20) NOT NULL COMMENT 'Positive integer source-currency units in the exact conversion ratio. Units: Positive integer native units interpreted using from_currency_id''s scale. Format: base-10 integer ratio denominator',
  MODIFY COLUMN `from_currency_id` int(11) NOT NULL COMMENT 'Source currency of the ratio.',
  MODIFY COLUMN `to_units` bigint(20) NOT NULL COMMENT 'Positive integer target-currency units in the exact conversion ratio. Units: Positive integer native units interpreted using to_currency_id''s scale. Format: base-10 integer ratio numerator',
  MODIFY COLUMN `to_currency_id` int(11) NOT NULL COMMENT 'Target currency, which must be the transaction valuation currency for transaction rates.';

SET SESSION foreign_key_checks = @accounting_previous_fk_checks;

-- end migration 0016

-- migration 0015: add-data-deletion-plans
-- writer downtime: not required; destructive data actions must remain
-- unavailable until this migration completes.
-- deployment order: apply before exposing import_restart or user_delete plans.
-- locking: the enum change requires a brief metadata lock on the short-lived
-- accounting_import_plans workflow table.
-- recovery: restore the verified pre-migration backup if rollback is required.

ALTER TABLE accounting_import_plans
  MODIFY import_kind
    ENUM('account_tree','transactions','account_delete','transaction_delete','import_restart','user_delete') NOT NULL;

-- end migration 0015

-- migration 0014: store-line-valuation-values
-- writer downtime: not required; the nullable column is additive.
-- deployment order: apply before accepting imports with distinct per-line
-- exchange rates.
-- locking: adding the column requires a brief metadata lock on line_items.
-- recovery: the new column is nullable and does not alter existing amounts;
-- restore the verified pre-migration backup if rollback is required.

ALTER TABLE line_items
  ADD COLUMN IF NOT EXISTS value_units BIGINT NULL AFTER amount_units;

-- Native-currency values are exact and can be populated without rounding.
UPDATE line_items li
JOIN accounts a ON a.account_id = li.account_id
JOIN transactions t ON t.transaction_id = li.transaction_id
   SET li.value_units = li.amount_units
 WHERE li.value_units IS NULL
   AND a.account_currency_id = t.valuation_currency_id;

-- end migration 0014

-- migration 0013: add-transaction-deletion-plans
-- writer downtime: not required; transaction deletion must remain unavailable
-- until this migration completes.
-- deployment order: apply before exposing preview_delete_transactions or
-- commit_delete_transactions.
-- locking: both enum changes require brief metadata locks on operational
-- workflow tables; ledger tables are not rewritten.
-- recovery: restore the verified pre-migration backup if rollback is required.

ALTER TABLE accounting_import_plans
  MODIFY import_kind
    ENUM('account_tree','transactions','account_delete','transaction_delete') NOT NULL;

ALTER TABLE accounting_transaction_import_items
  MODIFY item_status
    ENUM('staged','reused','exception','committed','deleted') NOT NULL;

-- end migration 0013

-- migration 0012: add-resumable-transaction-import-jobs
-- writer downtime: not required; these are independent operational staging
-- tables and do not change existing ledger rows.
-- deployment order: apply before exposing the resumable transaction-import
-- MCP tools.
-- locking: creation takes brief metadata locks only.
-- recovery: restore the verified pre-migration backup if rollback is required;
-- staged jobs may otherwise be dropped without changing committed ledger data.

CREATE TABLE IF NOT EXISTS accounting_transaction_import_jobs (
  import_job_id CHAR(36) NOT NULL,
  owner_person_id INT NOT NULL,
  client_request_id VARCHAR(128) NOT NULL,
  source_system VARCHAR(32) NOT NULL,
  source_file_sha256 CHAR(64) NOT NULL,
  source_file_name VARCHAR(1024) NULL,
  expected_record_count BIGINT UNSIGNED NOT NULL,
  job_status ENUM('receiving','review_ready','committed') NOT NULL DEFAULT 'receiving',
  preview_sha256 CHAR(64) NULL,
  result_json LONGTEXT NULL,
  committed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (import_job_id),
  UNIQUE KEY accounting_transaction_import_jobs_owner_request_UQ
    (owner_person_id, client_request_id),
  KEY accounting_transaction_import_jobs_owner_status_IDX
    (owner_person_id, job_status, updated_at),
  CONSTRAINT accounting_transaction_import_jobs_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='One durable source-file transaction import across idempotent chunks';

CREATE TABLE IF NOT EXISTS accounting_transaction_import_items (
  import_job_id CHAR(36) NOT NULL,
  transaction_external_id VARCHAR(128) NOT NULL,
  canonical_sha256 CHAR(64) NOT NULL,
  canonical_json LONGTEXT NOT NULL,
  resolved_json LONGTEXT NULL,
  source_record_count INT UNSIGNED NOT NULL,
  item_status ENUM('staged','reused','exception','committed') NOT NULL,
  ledger_transaction_id BIGINT NULL,
  errors_json LONGTEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (import_job_id, transaction_external_id),
  KEY accounting_transaction_import_items_ledger_IDX (ledger_transaction_id),
  KEY accounting_transaction_import_items_job_status_IDX
    (import_job_id, item_status, transaction_external_id),
  CONSTRAINT accounting_transaction_import_items_job_FK
    FOREIGN KEY (import_job_id) REFERENCES accounting_transaction_import_jobs (import_job_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT accounting_transaction_import_items_transaction_FK
    FOREIGN KEY (ledger_transaction_id) REFERENCES transactions (transaction_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Canonical transaction groups staged, reused, or retained as exceptions';

CREATE TABLE IF NOT EXISTS accounting_transaction_import_requests (
  import_job_id CHAR(36) NOT NULL,
  request_kind ENUM('chunk','exception_retry') NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  record_count INT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (import_job_id, request_kind, request_id),
  CONSTRAINT accounting_transaction_import_requests_job_FK
    FOREIGN KEY (import_job_id) REFERENCES accounting_transaction_import_jobs (import_job_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Idempotency receipts for import chunks and corrected exception retries';

-- end migration 0012

-- migration 0011: add-account-deletion-plans
-- writer downtime: not required; this extends the closed workflow-kind set used
-- by short-lived confirmation plans.
-- deployment order: apply before exposing preview_delete_account or
-- commit_delete_account.
-- locking: changing the enum requires a brief metadata lock on the import-plan
-- table.
-- recovery: restore the verified pre-migration backup if rollback is required.

ALTER TABLE accounting_import_plans
  MODIFY import_kind ENUM('account_tree','transactions','account_delete') NOT NULL;

-- end migration 0011

-- migration 0010: complete-durable-import-plan-workflow
-- writer downtime: not required; import plans are short-lived operational
-- records, but importing should be paused while this migration runs.
-- deployment order: apply this migration before restarting API versions that
-- return durable dry-run summaries and invalidation states.
-- locking: the plan table is altered twice and requires brief metadata locks.
-- recovery: restore the verified pre-migration backup if rollback is needed.

ALTER TABLE accounting_import_plans
  ADD COLUMN IF NOT EXISTS plan_status
    ENUM('ready','committed','invalidated') NULL AFTER import_kind,
  ADD COLUMN IF NOT EXISTS preview_sha256 CHAR(64) NULL AFTER payload_sha256,
  ADD COLUMN IF NOT EXISTS summary_json LONGTEXT NULL AFTER payload_json,
  ADD COLUMN IF NOT EXISTS invalidated_at DATETIME(6) NULL AFTER committed_at,
  ADD COLUMN IF NOT EXISTS invalidation_code VARCHAR(64) NULL AFTER invalidated_at;

UPDATE accounting_import_plans
   SET invalidated_at = CASE
         WHEN committed_at IS NULL THEN COALESCE(invalidated_at, CURRENT_TIMESTAMP(6))
         ELSE invalidated_at
       END,
       invalidation_code = CASE
         WHEN committed_at IS NULL THEN COALESCE(invalidation_code, 'SCHEMA_UPGRADE_REQUIRES_NEW_DRY_RUN')
         ELSE invalidation_code
       END,
       plan_status = CASE
         WHEN committed_at IS NULL THEN 'invalidated'
         ELSE 'committed'
       END
 WHERE plan_status IS NULL;

UPDATE accounting_import_plans
   SET preview_sha256 = COALESCE(preview_sha256, payload_sha256),
       summary_json = COALESCE(summary_json, CASE import_kind
         WHEN 'account_tree' THEN
           '{"accountsCreated":0,"accountsReused":0,"currenciesCreated":0,"currenciesReused":0,"rejectedRows":0}'
         ELSE
           '{"transactionsCreated":0,"transactionsReused":0,"lineItemsCreated":0,"lineItemsReused":0,"rejectedTransactions":0}'
       END)
 WHERE preview_sha256 IS NULL OR summary_json IS NULL;

ALTER TABLE accounting_import_plans
  MODIFY plan_status ENUM('ready','committed','invalidated') NOT NULL,
  MODIFY preview_sha256 CHAR(64) NOT NULL,
  MODIFY summary_json LONGTEXT NOT NULL,
  DROP COLUMN IF EXISTS item_count;

-- end migration 0010

-- migration 0009: add-durable-import-plans
-- writer downtime: not required; the transaction fingerprint is nullable for
-- existing rows and the plan table is independent operational metadata.
-- deployment order: apply this migration before restarting the API version
-- that exposes transaction import dry runs and plan confirmation.
-- locking: adding the nullable transaction column requires a metadata lock;
-- creating the new table does not rewrite accounting rows.
-- recovery: the new table and nullable column are non-destructive. Restore the
-- verified pre-migration backup if this schema version must be rolled back.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source_fingerprint CHAR(64) NULL AFTER source_id;

CREATE TABLE IF NOT EXISTS accounting_import_plans (
  import_plan_id CHAR(36) NOT NULL,
  owner_person_id INT NOT NULL,
  import_kind ENUM('account_tree','transactions') NOT NULL,
  source_system VARCHAR(32) NULL,
  payload_sha256 CHAR(64) NOT NULL,
  payload_json LONGTEXT NOT NULL,
  item_count INT UNSIGNED NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  committed_at DATETIME(6) NULL,
  result_json LONGTEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (import_plan_id),
  KEY accounting_import_plans_owner_created_IDX
    (owner_person_id, created_at, import_plan_id),
  KEY accounting_import_plans_expires_IDX (expires_at),
  CONSTRAINT accounting_import_plans_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Durable validated accounting imports awaiting explicit confirmation';

-- end migration 0009

-- migration 0008: add-user-owned-currencies
-- writer downtime: required while the API changes currency reads from a
-- global catalog to the authenticated user's global-plus-private catalog.
-- deployment order: apply this migration before restarting the API version
-- that reads currency ownership, display names, and semantic types.
-- locking: currencies is small, but its ALTER statements require metadata
-- locks and rebuild its uniqueness rule.
-- recovery: restore the verified pre-migration backup if the application must
-- be rolled back; changing scale remains outside this migration.

ALTER TABLE currencies
  ADD COLUMN IF NOT EXISTS owner_person_id INT NULL AFTER currency_id,
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) NULL AFTER CurrencyAbbreviation,
  ADD COLUMN IF NOT EXISTS currency_type
    ENUM('iso_4217','crypto','security','commodity','custom')
    NOT NULL DEFAULT 'iso_4217' AFTER display_name;

UPDATE currencies
   SET display_name = CurrencyAbbreviation
 WHERE display_name IS NULL;

UPDATE currencies
   SET currency_type = 'crypto'
 WHERE CurrencyAbbreviation IN ('BTC', 'BTC satoshi');

ALTER TABLE currencies
  MODIFY COLUMN display_name VARCHAR(255) NOT NULL,
  ADD COLUMN scope_owner_person_id INT NOT NULL DEFAULT 0,
  DROP INDEX currencies_unique,
  ADD UNIQUE KEY currencies_scope_code_UQ
    (scope_owner_person_id, CurrencyAbbreviation),
  ADD KEY currencies_owner_type_IDX
    (owner_person_id, currency_type, CurrencyAbbreviation),
  ADD CONSTRAINT currencies_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- end migration 0008

-- migration 0007: add-account-description-and-placeholder
-- writer downtime: not required; both columns have backward-compatible
-- defaults and existing accounts remain ordinary postable accounts.
-- deployment order: apply this migration before restarting the API version
-- that reads and writes account descriptions and placeholder state.
-- locking: a metadata lock is required while MariaDB alters accounts.
-- recovery: both additions are non-destructive; restore the pre-migration
-- backup if the application must be rolled back to the prior schema.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS description TEXT NULL AFTER AccountName,
  ADD COLUMN IF NOT EXISTS is_placeholder TINYINT(1) NOT NULL DEFAULT 0 AFTER description;

-- end migration 0007

-- migration 0006: add-user-api-tokens
-- writer downtime: not required; this creates an independent table used only
-- by the new MCP endpoint.
-- deployment order: apply this migration before restarting the API with MCP
-- enabled, because bearer-token authentication reads this table.
-- locking: brief metadata locks occur while MariaDB creates the table and keys.
-- recovery: revoke or drop API tokens if the MCP integration must be disabled;
-- restoring the pre-migration backup is not required for ledger data.

CREATE TABLE IF NOT EXISTS api_tokens (
  api_token_id BIGINT NOT NULL AUTO_INCREMENT,
  owner_person_id INT NOT NULL,
  token_name VARCHAR(128) NOT NULL,
  token_prefix VARCHAR(20) NOT NULL COMMENT 'Non-secret prefix shown when listing tokens',
  token_hash BINARY(32) NOT NULL COMMENT 'SHA-256 of a 256-bit random bearer token',
  expires_at DATETIME(6) NULL,
  last_used_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (api_token_id),
  UNIQUE KEY api_tokens_hash_UQ (token_hash),
  KEY api_tokens_owner_created_IDX (owner_person_id, created_at, api_token_id),
  CONSTRAINT api_tokens_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Revocable long-lived bearer credentials for MCP and API clients';

-- end migration 0006

-- migration 0005: remove-book-currency-default
-- writer downtime: not required; the API does not need the profile table after
-- this release, and no ledger entries or accounts depend on it.
-- deployment order: restart the version-5 API before applying this migration;
-- the new API works before and after the table is removed.
-- locking: brief metadata locks while the account default is removed and the
-- obsolete profile table is dropped.
-- recovery: restore the pre-migration backup only if the old currency preference
-- is needed; no accounting entries or account currencies are changed.

ALTER TABLE accounts
  MODIFY AccountType ENUM('asset','liability','income','expense','equity') NOT NULL;

DROP TABLE IF EXISTS accounting_profiles;

-- end migration 0005

-- migration 0004: add-account-balance-assertions
-- writer downtime: not required; this creates an independent empty table.
-- locking: brief metadata locks occur while MariaDB creates the table and keys.
-- recovery: the CREATE TABLE is idempotent and may be rerun after inspection.

CREATE TABLE IF NOT EXISTS account_balance_assertions (
  account_balance_assertion_id BIGINT NOT NULL AUTO_INCREMENT,
  owner_person_id INT NOT NULL,
  account_id INT NOT NULL,
  balance_date DATE NOT NULL COMMENT 'Known balance at the end of this date',
  known_balance_units BIGINT NOT NULL COMMENT 'Native smallest units of the account currency',
  PRIMARY KEY (account_balance_assertion_id),
  UNIQUE KEY account_balance_assertions_account_date_UQ (account_id, balance_date),
  KEY account_balance_assertions_owner_date_IDX (owner_person_id, balance_date, account_id),
  CONSTRAINT account_balance_assertions_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT account_balance_assertions_account_FK
    FOREIGN KEY (account_id) REFERENCES accounts (account_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='User-entered end-of-day balances used to reconcile the derived ledger';

-- end migration 0004

-- migration 0003: expand-and-seed-currencies
-- writer downtime: not required; the currencies table is small.
-- locking: one brief metadata lock while widening the identifier column.
-- recovery: the ALTER and upsert are idempotent and may be rerun after inspection.
-- source: ISO 4217 List One published 2026-01-01 by SIX, the official
-- maintenance agency. Codes whose official minor unit is N.A. are omitted
-- rather than inaccurately treating them as whole-unit commodities.

ALTER TABLE currencies
  MODIFY CurrencyAbbreviation VARCHAR(50) NOT NULL;

INSERT INTO currencies (CurrencyAbbreviation, scale)
VALUES
  ('AED', 2),
  ('AFN', 2),
  ('ALL', 2),
  ('AMD', 2),
  ('AOA', 2),
  ('ARS', 2),
  ('AUD', 2),
  ('AWG', 2),
  ('AZN', 2),
  ('BAM', 2),
  ('BBD', 2),
  ('BDT', 2),
  ('BHD', 3),
  ('BIF', 0),
  ('BMD', 2),
  ('BND', 2),
  ('BOB', 2),
  ('BOV', 2),
  ('BRL', 2),
  ('BSD', 2),
  ('BTC', 8),
  ('BTC satoshi', 0),
  ('BTN', 2),
  ('BWP', 2),
  ('BYN', 2),
  ('BZD', 2),
  ('CAD', 2),
  ('CDF', 2),
  ('CHE', 2),
  ('CHF', 2),
  ('CHW', 2),
  ('CLF', 4),
  ('CLP', 0),
  ('CNY', 2),
  ('COP', 2),
  ('COU', 2),
  ('CRC', 2),
  ('CUP', 2),
  ('CVE', 2),
  ('CZK', 2),
  ('DJF', 0),
  ('DKK', 2),
  ('DOP', 2),
  ('DZD', 2),
  ('EGP', 2),
  ('ERN', 2),
  ('ETB', 2),
  ('EUR', 2),
  ('FJD', 2),
  ('FKP', 2),
  ('GBP', 2),
  ('GEL', 2),
  ('GHS', 2),
  ('GIP', 2),
  ('GMD', 2),
  ('GNF', 0),
  ('GTQ', 2),
  ('GYD', 2),
  ('HKD', 2),
  ('HNL', 2),
  ('HTG', 2),
  ('HUF', 2),
  ('IDR', 2),
  ('ILS', 2),
  ('INR', 2),
  ('IQD', 3),
  ('IRR', 2),
  ('ISK', 0),
  ('JMD', 2),
  ('JOD', 3),
  ('JPY', 0),
  ('KES', 2),
  ('KGS', 2),
  ('KHR', 2),
  ('KMF', 0),
  ('KPW', 2),
  ('KRW', 0),
  ('KWD', 3),
  ('KYD', 2),
  ('KZT', 2),
  ('LAK', 2),
  ('LBP', 2),
  ('LKR', 2),
  ('LRD', 2),
  ('LSL', 2),
  ('LYD', 3),
  ('MAD', 2),
  ('MDL', 2),
  ('MGA', 2),
  ('MKD', 2),
  ('MMK', 2),
  ('MNT', 2),
  ('MOP', 2),
  ('MRU', 2),
  ('MUR', 2),
  ('MVR', 2),
  ('MWK', 2),
  ('MXN', 2),
  ('MXV', 2),
  ('MYR', 2),
  ('MZN', 2),
  ('NAD', 2),
  ('NGN', 2),
  ('NIO', 2),
  ('NOK', 2),
  ('NPR', 2),
  ('NZD', 2),
  ('OMR', 3),
  ('PAB', 2),
  ('PEN', 2),
  ('PGK', 2),
  ('PHP', 2),
  ('PKR', 2),
  ('PLN', 2),
  ('PYG', 0),
  ('QAR', 2),
  ('RON', 2),
  ('RSD', 2),
  ('RUB', 2),
  ('RWF', 0),
  ('SAR', 2),
  ('SBD', 2),
  ('SCR', 2),
  ('SDG', 2),
  ('SEK', 2),
  ('SGD', 2),
  ('SHP', 2),
  ('SLE', 2),
  ('SOS', 2),
  ('SRD', 2),
  ('SSP', 2),
  ('STN', 2),
  ('SVC', 2),
  ('SYP', 2),
  ('SZL', 2),
  ('THB', 2),
  ('TJS', 2),
  ('TMT', 2),
  ('TND', 3),
  ('TOP', 2),
  ('TRY', 2),
  ('TTD', 2),
  ('TWD', 2),
  ('TZS', 2),
  ('UAH', 2),
  ('UGX', 0),
  ('USD', 2),
  ('USN', 2),
  ('UYI', 0),
  ('UYU', 2),
  ('UYW', 4),
  ('UZS', 2),
  ('VED', 2),
  ('VES', 2),
  ('VND', 0),
  ('VUV', 0),
  ('WST', 2),
  ('XAD', 2),
  ('XAF', 0),
  ('XCD', 2),
  ('XCG', 2),
  ('XOF', 0),
  ('XPF', 0),
  ('YER', 2),
  ('ZAR', 2),
  ('ZMW', 2),
  ('ZWG', 2)
ON DUPLICATE KEY UPDATE scale = VALUES(scale);

-- end migration 0003

-- migration 0002: add-user-owned-accounting
-- writer downtime: required; existing accounting tables are altered.
-- locking: brief metadata locks plus table rebuilds may occur. The initial live
-- database is expected to contain no ledger data.
-- recovery: restore the verified pre-migration backup if any ALTER statement
-- commits and a later statement fails. Do not mark the database migrated by hand.

CREATE TABLE IF NOT EXISTS people2_people (
  person_id INT NOT NULL AUTO_INCREMENT,
  Name VARCHAR(100) NOT NULL,
  OwnerEmail VARCHAR(255) NOT NULL,
  OwnerPasscode VARCHAR(255) NOT NULL COMMENT 'scrypt password hash; never plaintext',
  EnteredAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UpdatedAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (person_id),
  UNIQUE KEY people2_people_OwnerEmail_UQ (OwnerEmail)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Minimal person identity derived from the TLOM people2_people model';

INSERT INTO currencies (CurrencyAbbreviation, scale)
VALUES ('USD', 2), ('BTC', 8), ('PEN', 2)
ON DUPLICATE KEY UPDATE scale = VALUES(scale);

CREATE TABLE IF NOT EXISTS accounting_profiles (
  person_id INT NOT NULL,
  functional_currency_id INT NOT NULL,
  EnteredAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UpdatedAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (person_id),
  KEY accounting_profiles_currency_IDX (functional_currency_id),
  CONSTRAINT accounting_profiles_person_FK
    FOREIGN KEY (person_id) REFERENCES people2_people (person_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT accounting_profiles_currency_FK
    FOREIGN KEY (functional_currency_id) REFERENCES currencies (currency_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Exactly one accounting ledger profile per person';

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS owner_person_id INT NULL AFTER account_id,
  ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS source_id VARCHAR(128) NULL;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS owner_person_id INT NULL AFTER transaction_id,
  ADD COLUMN IF NOT EXISTS reversal_of_transaction_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS source_id VARCHAR(128) NULL;

ALTER TABLE line_items
  ADD COLUMN IF NOT EXISTS reconciliation_state
    ENUM('unreconciled','cleared','reconciled') NOT NULL DEFAULT 'unreconciled',
  ADD COLUMN IF NOT EXISTS reconciled_at DATE NULL,
  ADD COLUMN IF NOT EXISTS source_id VARCHAR(128) NULL;

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS owner_person_id INT NULL AFTER tag_id;

ALTER TABLE xrates
  ADD COLUMN IF NOT EXISTS owner_person_id INT NULL AFTER xrate_id;

ALTER TABLE accounts
  MODIFY owner_person_id INT NOT NULL,
  ADD KEY accounts_owner_IDX (owner_person_id),
  ADD UNIQUE KEY accounts_owner_source_UQ (owner_person_id, source_system, source_id),
  ADD CONSTRAINT accounts_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE transactions
  MODIFY owner_person_id INT NOT NULL,
  ADD KEY transactions_owner_date_IDX (owner_person_id, TransactionDate, transaction_id),
  ADD KEY transactions_reversal_IDX (reversal_of_transaction_id),
  ADD UNIQUE KEY transactions_owner_source_UQ (owner_person_id, source_system, source_id),
  ADD CONSTRAINT transactions_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_reversal_FK
    FOREIGN KEY (reversal_of_transaction_id) REFERENCES transactions (transaction_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE line_items
  ADD UNIQUE KEY line_items_transaction_source_UQ (transaction_id, source_id);

ALTER TABLE tags DROP INDEX tags_unique;
ALTER TABLE tags
  MODIFY owner_person_id INT NOT NULL,
  ADD KEY tags_owner_key_IDX (owner_person_id, tag_key),
  ADD UNIQUE KEY tags_owner_key_value_UQ
    (owner_person_id, tag_key, tag_value) USING HASH,
  ADD CONSTRAINT tags_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE xrates
  MODIFY owner_person_id INT NOT NULL,
  ADD KEY xrates_owner_reference_lookup_IDX
    (owner_person_id, xrate_type, from_currency_id, to_currency_id, ValidAt),
  ADD CONSTRAINT xrates_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

-- end migration 0002

-- migration 0001: establish-migration-baseline
-- writer downtime: not required for this additive bootstrap.
-- locking: one small CREATE TABLE and singleton INSERT.
-- recovery: this block is idempotent and may be rerun after inspection.

CREATE TABLE IF NOT EXISTS accounting_schema_metadata (
  singleton TINYINT UNSIGNED NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  last_migration VARCHAR(160) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (singleton),
  CONSTRAINT accounting_schema_metadata_singleton_chk CHECK (singleton = 1)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Singleton schema version for the accounting migration ledger';

INSERT INTO accounting_schema_metadata
  (singleton, schema_version, last_migration)
VALUES
  (1, 0, 'bootstrap-pending')
ON DUPLICATE KEY UPDATE singleton = VALUES(singleton);

-- end migration 0001
