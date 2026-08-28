-- Chapeaux Fous Accounting MariaDB migration ledger.
--
-- Add new migrations directly below this header, newest first. The runner
-- validates newest-first file order and applies pending migrations oldest first.
-- Marker format:
--   -- migration 0006: short-description
--   <schema and data SQL>
--   -- end migration 0006

-- migration 0014: add-resumable-artifact-uploads
-- writer downtime: not required; these are independent transport tables and
-- do not change ledger rows or existing import-job rows.
-- deployment order: apply before advertising artifact input for transaction
-- import jobs.
-- locking: table creation takes brief metadata locks only.
-- recovery: restore the verified pre-migration backup if rollback is required;
-- incomplete transport artifacts may otherwise be deleted without changing
-- staged or committed accounting data.

CREATE TABLE IF NOT EXISTS accounting_artifact_uploads (
  artifact_id CHAR(36) NOT NULL,
  owner_person_id INT NOT NULL,
  client_request_id VARCHAR(128) NOT NULL,
  file_name VARCHAR(1024) NULL,
  media_type VARCHAR(255) NOT NULL,
  expected_byte_size BIGINT UNSIGNED NOT NULL,
  received_byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expected_sha256 CHAR(64) NOT NULL,
  upload_status ENUM('receiving','complete') NOT NULL DEFAULT 'receiving',
  completed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (artifact_id),
  UNIQUE KEY accounting_artifact_uploads_owner_request_UQ
    (owner_person_id, client_request_id),
  KEY accounting_artifact_uploads_owner_status_IDX
    (owner_person_id, upload_status, updated_at),
  CONSTRAINT accounting_artifact_uploads_owner_FK
    FOREIGN KEY (owner_person_id) REFERENCES people2_people (person_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Owner-scoped resumable uploads verified before provider consumption';

CREATE TABLE IF NOT EXISTS accounting_artifact_chunks (
  artifact_id CHAR(36) NOT NULL,
  byte_offset BIGINT UNSIGNED NOT NULL,
  byte_count INT UNSIGNED NOT NULL,
  chunk_sha256 CHAR(64) NOT NULL,
  chunk_bytes MEDIUMBLOB NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (artifact_id, byte_offset),
  CONSTRAINT accounting_artifact_chunks_upload_FK
    FOREIGN KEY (artifact_id) REFERENCES accounting_artifact_uploads (artifact_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Exact byte ranges for resumable owner-scoped artifact uploads';

CREATE TABLE IF NOT EXISTS accounting_transaction_import_artifacts (
  import_job_id CHAR(36) NOT NULL,
  artifact_id CHAR(36) NOT NULL,
  attached_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (import_job_id),
  UNIQUE KEY accounting_transaction_import_artifacts_artifact_UQ (artifact_id),
  CONSTRAINT accounting_transaction_import_artifacts_job_FK
    FOREIGN KEY (import_job_id) REFERENCES accounting_transaction_import_jobs (import_job_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT accounting_transaction_import_artifacts_upload_FK
    FOREIGN KEY (artifact_id) REFERENCES accounting_artifact_uploads (artifact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci
  COMMENT='Binds one verified canonical artifact to one logical import job';

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
