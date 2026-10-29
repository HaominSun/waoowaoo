-- Organization tables existed before 20260626120000_upgrade_saas_platform via db push.
-- Create them here so `prisma migrate deploy` can replay that migration on an empty database.
-- Existing db-push databases: see prisma/migrations/BOOTSTRAP.md. Rehearse on a
-- copy of production. Do not mark this migration applied unless
-- `scripts/migrate-baseline-check.ts` reports an empty diff against
-- prisma/baseline/schema.pre-credit-quota.prisma.

CREATE TABLE `organizations` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `organization_members` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'member',
    `quota` DECIMAL(18, 6) NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `organization_members_organizationId_idx`(`organizationId`),
    INDEX `organization_members_userId_idx`(`userId`),
    UNIQUE INDEX `organization_members_organizationId_userId_key`(`organizationId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `organization_balances` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `balance` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `frozenAmount` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `totalSpent` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organization_balances_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `organization_usages` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 6) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `organization_usages_organizationId_idx`(`organizationId`),
    INDEX `organization_usages_userId_idx`(`userId`),
    INDEX `organization_usages_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `organizations` ADD CONSTRAINT `organizations_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `organization_balances` ADD CONSTRAINT `organization_balances_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `organization_usages` ADD CONSTRAINT `organization_usages_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
