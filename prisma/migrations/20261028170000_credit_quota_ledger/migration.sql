-- Credit quota ledger groundwork.
--
-- OrganizationMember.quota historically used 0 as unlimited (column comment and the
-- live entitlement gate both skip the cap when quota is not > 0). New semantics are
-- null = unlimited and 0 = forbidden. Copying 0 into
-- organization_member_quota_zero_backup and setting those rows to null preserves
-- today's effective unlimited behavior.
--
-- Risk: a member whose 0 was intentionally "disabled" becomes unlimited. Review the
-- backup table before relying on the new 0 = forbidden rule. Rollback restores only
-- rows that are still null, then deletes the marker. Re-applying this migration
-- after that rollback converts every current 0 again.
--
-- The marker makes the data change idempotent. A second run does not convert quota
-- values, including a 0 stored after this migration to mean forbidden.
-- Amounts stay in CNY. credits_per_cny is a placeholder display rate.

CREATE TABLE IF NOT EXISTS `credit_accounts` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `scope` VARCHAR(191) NOT NULL,
  `memberId` VARCHAR(191) NULL,
  `holderKey` VARCHAR(191) NOT NULL,
  `periodStart` DATETIME(3) NOT NULL,
  `periodEnd` DATETIME(3) NOT NULL,
  `quotaAmount` DECIMAL(18, 6) NULL,
  `usedAmount` DECIMAL(18, 6) NOT NULL DEFAULT 0,
  `frozenAmount` DECIMAL(18, 6) NOT NULL DEFAULT 0,
  `currency` VARCHAR(191) NOT NULL DEFAULT 'CNY',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `credit_accounts_period_holder_key` (`organizationId`, `holderKey`, `periodStart`, `periodEnd`),
  INDEX `credit_accounts_organizationId_periodStart_idx` (`organizationId`, `periodStart`),
  INDEX `credit_accounts_memberId_idx` (`memberId`),
  CONSTRAINT `credit_accounts_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `credit_accounts_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `organization_members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `quota_allocation_logs` (
  `id` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `memberId` VARCHAR(191) NULL,
  `creditAccountId` VARCHAR(191) NULL,
  `target` VARCHAR(191) NOT NULL,
  `oldValue` DECIMAL(18, 6) NULL,
  `newValue` DECIMAL(18, 6) NULL,
  `reason` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `quota_allocation_logs_organizationId_createdAt_idx` (`organizationId`, `createdAt`),
  INDEX `quota_allocation_logs_memberId_idx` (`memberId`),
  INDEX `quota_allocation_logs_actorId_idx` (`actorId`),
  INDEX `quota_allocation_logs_creditAccountId_idx` (`creditAccountId`),
  CONSTRAINT `quota_allocation_logs_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `quota_allocation_logs_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `quota_allocation_logs_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `organization_members`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `quota_allocation_logs_creditAccountId_fkey` FOREIGN KEY (`creditAccountId`) REFERENCES `credit_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `credit_ledger_entries` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `operationType` VARCHAR(191) NOT NULL,
  `quantity` DECIMAL(18, 6) NOT NULL,
  `estimatedAmount` DECIMAL(18, 6) NOT NULL,
  `actualAmount` DECIMAL(18, 6) NULL,
  `planCreditPortion` DECIMAL(18, 6) NOT NULL DEFAULT 0,
  `balancePortion` DECIMAL(18, 6) NOT NULL DEFAULT 0,
  `arrearsPortion` DECIMAL(18, 6) NOT NULL DEFAULT 0,
  `organizationId` VARCHAR(191) NULL,
  `userId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL,
  `currency` VARCHAR(191) NOT NULL DEFAULT 'CNY',
  `frozenAt` DATETIME(3) NULL,
  `settledAt` DATETIME(3) NULL,
  `rolledBackAt` DATETIME(3) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `credit_ledger_entries_taskId_key` (`taskId`),
  INDEX `credit_ledger_entries_organizationId_idx` (`organizationId`),
  INDEX `credit_ledger_entries_userId_idx` (`userId`),
  INDEX `credit_ledger_entries_projectId_idx` (`projectId`),
  INDEX `credit_ledger_entries_status_idx` (`status`),
  CONSTRAINT `credit_ledger_entries_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `credit_ledger_entries_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `credit_ledger_entries_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `organization_member_quota_zero_backup` (
  `id` VARCHAR(191) NOT NULL,
  `memberId` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `oldQuota` DECIMAL(18, 6) NOT NULL,
  `backedUpAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `organization_member_quota_zero_backup_memberId_key` (`memberId`),
  INDEX `organization_member_quota_zero_backup_organizationId_idx` (`organizationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `billing_data_migration_markers` (
  `name` VARCHAR(191) NOT NULL,
  `appliedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `details` JSON NULL,
  PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @arrears_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'organization_balances'
    AND COLUMN_NAME = 'arrears'
);
SET @sql := IF(
  @arrears_exists = 0,
  'ALTER TABLE `organization_balances` ADD COLUMN `arrears` DECIMAL(18, 6) NOT NULL DEFAULT 0',
  'DO 0'
);
PREPARE credit_quota_stmt FROM @sql;
EXECUTE credit_quota_stmt;
DEALLOCATE PREPARE credit_quota_stmt;

SET @quota_default := (
  SELECT COLUMN_DEFAULT
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'organization_members'
    AND COLUMN_NAME = 'quota'
);
SET @sql := IF(
  @quota_default IS NULL,
  'DO 0',
  'ALTER TABLE `organization_members` ALTER COLUMN `quota` DROP DEFAULT'
);
PREPARE credit_quota_stmt FROM @sql;
EXECUTE credit_quota_stmt;
DEALLOCATE PREPARE credit_quota_stmt;

INSERT INTO `organization_member_quota_zero_backup` (`id`, `memberId`, `organizationId`, `userId`, `oldQuota`, `backedUpAt`)
SELECT m.`id`, m.`id`, m.`organizationId`, m.`userId`, m.`quota`, CURRENT_TIMESTAMP(3)
FROM `organization_members` AS m
WHERE m.`quota` = 0
  AND NOT EXISTS (
    SELECT 1
    FROM `billing_data_migration_markers` AS marker
    WHERE marker.`name` = 'organization_member_quota_0_to_null'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `organization_member_quota_zero_backup` AS backup
    WHERE backup.`memberId` = m.`id`
  );

UPDATE `organization_members` AS m
SET m.`quota` = NULL
WHERE m.`quota` = 0
  AND NOT EXISTS (
    SELECT 1
    FROM `billing_data_migration_markers` AS marker
    WHERE marker.`name` = 'organization_member_quota_0_to_null'
  );

INSERT INTO `billing_data_migration_markers` (`name`, `appliedAt`, `details`)
SELECT 'organization_member_quota_0_to_null', CURRENT_TIMESTAMP(3), JSON_OBJECT('reason', 'legacy OrganizationMember.quota 0 meant unlimited; null preserves that behavior')
WHERE NOT EXISTS (
  SELECT 1
  FROM `billing_data_migration_markers` AS marker
  WHERE marker.`name` = 'organization_member_quota_0_to_null'
);

INSERT INTO `system_configs` (`id`, `key`, `value`, `description`, `updatedAt`)
SELECT 'cfg_credits_per_cny', 'credits_per_cny', '1', 'Placeholder display rate. Ledger amounts stay in CNY. 1 credit equals 1 CNY until product sets the rate.', CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs` AS config
  WHERE config.`key` = 'credits_per_cny'
);
