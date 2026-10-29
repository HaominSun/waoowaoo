# Existing databases

Rehearse on a copy of production first. Do not point these commands at production until that copy finishes `prisma migrate deploy` cleanly.

These three migrations exist so an empty database can replay history:

- `20260301000000_baseline`
- `20260625120000_create_organization_base`
- `20261028160000_platform_admin_schema`

An existing database may already contain some of their tables. Do not blanket-mark them with `prisma migrate resolve --applied`.

1. Restore a copy of production and set `DATABASE_URL` to that copy.
2. Preview. This only reads `information_schema`:

```bash
npx tsx scripts/migrate-baseline-check.ts --dry-run
```

3. The checker judges each migration on its own:

- Every table it creates is present, and the columns defined in that file match type and nullability: that migration alone may be marked applied. Extra columns from later migrations are allowed.
- None of its tables or added columns are present: leave it for `prisma migrate deploy`.
- Some tables exist, a declared column is missing, or a type or nullability differs: the checker prints the difference, marks nothing, and exits non-zero. Repair the copy or add a forward migration. Do not resolve that migration by hand.

4. On the copy, run the checker without `--dry-run`, then:

```bash
npx prisma migrate deploy --schema prisma/schema.prisma
```

5. Repeat on production only after the copy succeeds.

`prisma migrate diff --from-url "$DATABASE_URL" --to-migrations prisma/migrations --shadow-database-url "$SHADOW_DATABASE_URL"` is a second look at history drift. It does not replace the per-migration check.
