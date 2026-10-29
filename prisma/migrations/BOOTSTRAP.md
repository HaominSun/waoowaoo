# Existing databases (db push) before the credit-quota migration

Rehearse on a copy of production first. Do not point these commands at production until the copy succeeds.

`prisma db push` databases have an empty `_prisma_migrations` table. Running `prisma migrate deploy` there would replay every historical migration and fail. The credit-quota migration is `20261028170000_credit_quota_ledger`.

The committed snapshot `prisma/baseline/schema.pre-credit-quota.prisma` is `prisma/schema.prisma` at the merge-base before that migration.

1. Restore a copy of production and set `DATABASE_URL` to that copy.
2. Compare the copy to the snapshot:

```bash
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/baseline/schema.pre-credit-quota.prisma \
  --exit-code \
  --script
```

3. Or run the checker, which does that diff:

```bash
npx tsx scripts/migrate-baseline-check.ts --dry-run
```

- Empty diff (exit 0): the checker may `prisma migrate resolve --applied` for **every** migration except `20261028170000_credit_quota_ledger`, including `20260301000000_baseline`, `20260625120000_create_organization_base`, and `20261028160000_platform_admin_schema`. `--dry-run` only prints those names and writes nothing.
- Non-empty diff: the checker marks nothing, prints the diff, and exits non-zero. Repair the copy. Do not resolve migrations by hand.

`prisma migrate diff` exit 1 is a tool or connection failure. Exit 2 means the database does not match the snapshot. The checker marks nothing in both cases and uses those exit codes itself. Only exit 0 continues.

4. On the copy, run without `--dry-run`. The checker marks the historical migrations, then runs the same diff again.

```bash
npx tsx scripts/migrate-baseline-check.ts
npx prisma migrate deploy --schema prisma/schema.prisma
```

`migrate deploy` then applies only `20261028170000_credit_quota_ledger`.

If that second diff is not empty (exit 2), or the diff command fails (exit 1), the rows for this run are already in `_prisma_migrations`. The checker prints each `migration_name` it inserted and a `DELETE` for those names only. Run that statement on the copy, fix the database, then run the checker again. Do not delete any other `_prisma_migrations` rows.

```sql
DELETE FROM `_prisma_migrations`
WHERE `migration_name` IN (
  -- names printed by scripts/migrate-baseline-check.ts
);
```

5. Repeat on production only after the copy succeeds.

If those historical migrations are already recorded in `_prisma_migrations`, the checker does nothing.
