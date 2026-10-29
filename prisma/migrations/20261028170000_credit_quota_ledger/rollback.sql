-- Roll back the OrganizationMember.quota 0 → null conversion.
-- Prisma migrate does not run this file. Apply it manually, or run:
--   npx tsx scripts/billing/member-quota-zero-to-null.ts --rollback
--
-- Only rows that are still NULL are restored, and only from the backup.
-- A quota set after the migration (including an intentional 0 = forbidden) is left alone.
-- Backup rows are kept. The marker is removed, so re-applying the forward migration
-- converts every quota that is 0 at that later time.

UPDATE `organization_members` AS m
INNER JOIN `organization_member_quota_zero_backup` AS b ON b.`memberId` = m.`id`
SET m.`quota` = b.`oldQuota`
WHERE m.`quota` IS NULL;

DELETE FROM `billing_data_migration_markers`
WHERE `name` = 'organization_member_quota_0_to_null';
