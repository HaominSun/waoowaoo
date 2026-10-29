#!/usr/bin/env bash
# Apply every Prisma migration to the database in DATABASE_URL.
# The database must already exist and be empty.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

npx prisma migrate deploy --schema prisma/schema.prisma
npx prisma migrate diff \
  --from-url "${DATABASE_URL}" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code \
  --script
