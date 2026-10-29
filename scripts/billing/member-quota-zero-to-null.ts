import { prisma } from '@/lib/prisma'
import {
  MEMBER_QUOTA_ROLLBACK_STATEMENTS,
  MEMBER_QUOTA_ZERO_TO_NULL_STATEMENTS,
} from '@/lib/billing/quota-migration'

async function main() {
  const rollback = process.argv.includes('--rollback')
  const statements = rollback ? MEMBER_QUOTA_ROLLBACK_STATEMENTS : MEMBER_QUOTA_ZERO_TO_NULL_STATEMENTS
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
  process.stdout.write(`${rollback ? 'Rolled back' : 'Applied'} member quota 0 → null migration (${statements.length} statements).\n`)
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[member-quota-zero-to-null] FAILED: ${message}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
