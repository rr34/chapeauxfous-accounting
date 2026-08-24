-- Chapeaux Fous Accounting MariaDB migration ledger.
--
-- Add new migrations directly below this header, newest first. The runner
-- validates newest-first file order and applies pending migrations oldest first.
-- Marker format:
--   -- migration 0003: short-description
--   <schema and data SQL>
--   -- end migration 0003

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
