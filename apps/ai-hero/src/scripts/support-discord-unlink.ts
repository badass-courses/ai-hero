import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { closeDatabasePool, db } from '@/db'
import { accounts, purchases, users } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

// Finite support operator, not the customer's self-service disconnect action.
// Input stays in a 0600 temporary file. Output and receipts contain identifiers
// and hashes only, never emails, OAuth tokens, or provider account IDs.
const Case = z.object({
  runId: z.string().min(1),
  conversationId: z.string().regex(/^cnv_/),
  approvalReference: z.string().min(1),
  expectedInboundId: z.string().regex(/^msg_/),
  oldUserId: z.string().uuid(),
  oldEmail: z.string().email(),
  personalUserId: z.string().uuid(),
  personalEmail: z.string().email(),
  providerAccountSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPersonalPurchaseIds: z.array(z.string().min(1)).min(1),
}).strict()
export type DiscordUnlinkCase = z.infer<typeof Case>

type Account = { userId: string; provider: string; providerAccountId: string }
type Purchase = { id: string; userId: string | null; status: string }
type Snapshot = {
  oldEmail: string | null
  personalEmail: string | null
  oldAccounts: Account[]
  personalAccounts: Account[]
  oldPurchases: Purchase[]
  personalPurchases: Purchase[]
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const keys = (rows: Account[]) => rows.map((row) => `${row.provider}:${hash(row.providerAccountId)}`).sort()
const purchaseKeys = (rows: Purchase[]) => rows.map((row) => `${row.id}:${row.status}`).sort()
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b)

export function guardDiscordUnlink(input: DiscordUnlinkCase, before: Snapshot): string | null {
  if (input.oldUserId === input.personalUserId || input.oldEmail.toLowerCase() === input.personalEmail.toLowerCase()) return 'same_identity'
  if (before.oldEmail?.toLowerCase() !== input.oldEmail.toLowerCase() || before.personalEmail?.toLowerCase() !== input.personalEmail.toLowerCase()) return 'identity_mismatch'
  const oldDiscord = before.oldAccounts.filter((a) => a.provider === 'discord')
  if (oldDiscord.length !== 1 || hash(oldDiscord[0]!.providerAccountId) !== input.providerAccountSha256) return 'old_discord_mismatch'
  if (before.personalAccounts.some((a) => a.provider === 'discord')) return 'personal_discord_collision'
  if (before.oldPurchases.length !== 0) return 'old_account_has_purchases'
  if (before.personalPurchases.some((p) => p.userId !== input.personalUserId || !['Valid', 'Restricted'].includes(p.status))) return 'personal_purchase_not_active'
  if (new Set(input.expectedPersonalPurchaseIds).size !== input.expectedPersonalPurchaseIds.length ||
      !same(before.personalPurchases.map((p) => p.id).sort(), [...input.expectedPersonalPurchaseIds].sort())) return 'personal_purchase_mismatch'
  return null
}

export function verifyDiscordUnlink(before: Snapshot, after: Snapshot): boolean {
  return before.oldEmail === after.oldEmail && before.personalEmail === after.personalEmail &&
    same(keys(before.oldAccounts.filter((a) => a.provider !== 'discord')), keys(after.oldAccounts)) &&
    same(keys(before.personalAccounts), keys(after.personalAccounts)) &&
    same(purchaseKeys(before.oldPurchases), purchaseKeys(after.oldPurchases)) &&
    same(purchaseKeys(before.personalPurchases), purchaseKeys(after.personalPurchases))
}

async function snapshot(input: DiscordUnlinkCase): Promise<Snapshot> {
  const userRows = await db.select({ id: users.id, email: users.email }).from(users)
    .where(inArray(users.id, [input.oldUserId, input.personalUserId]))
  const accountRows = await db.select({ userId: accounts.userId, provider: accounts.provider, providerAccountId: accounts.providerAccountId })
    .from(accounts).where(inArray(accounts.userId, [input.oldUserId, input.personalUserId]))
  const purchaseRows = await db.select({ id: purchases.id, userId: purchases.userId, status: purchases.status })
    .from(purchases).where(inArray(purchases.userId, [input.oldUserId, input.personalUserId]))
  return {
    oldEmail: userRows.find((u) => u.id === input.oldUserId)?.email ?? null,
    personalEmail: userRows.find((u) => u.id === input.personalUserId)?.email ?? null,
    oldAccounts: accountRows.filter((a) => a.userId === input.oldUserId),
    personalAccounts: accountRows.filter((a) => a.userId === input.personalUserId),
    oldPurchases: purchaseRows.filter((p) => p.userId === input.oldUserId),
    personalPurchases: purchaseRows.filter((p) => p.userId === input.personalUserId),
  }
}

export async function runDiscordUnlink(args: string[]) {
  const inputIndex = args.indexOf('--input')
  const receiptIndex = args.indexOf('--receipt')
  const allowWrite = args.includes('--allow-write')
  if (inputIndex < 0 || !args[inputIndex + 1] || args.length !== (allowWrite ? 5 : 2) ||
    (allowWrite && (receiptIndex < 0 || !args[receiptIndex + 1]))) throw new Error('Usage: --input <0600 temporary JSON> [--allow-write --receipt <new path>]')
  const path = args[inputIndex + 1]!
  if (!path.startsWith('/tmp/') && !path.startsWith('/private/tmp/')) throw new Error('Input must be a temporary file')
  const file = await lstat(path)
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) throw new Error('Input must be a 0600 regular file')
  const input = Case.parse(JSON.parse(await readFile(path, 'utf8')))
  const before = await snapshot(input)
  const blocked = guardDiscordUnlink(input, before)
  const base = { schema: 'aihero.support-discord-unlink.v1', runId: input.runId, conversationId: input.conversationId,
    approvalReference: input.approvalReference, expectedInboundId: input.expectedInboundId,
    oldUserId: input.oldUserId, personalUserId: input.personalUserId,
    providerAccountSha256: input.providerAccountSha256, oldPurchaseCount: before.oldPurchases.length,
    personalPurchaseIds: before.personalPurchases.map((p) => p.id).sort(),
    oldAccountProviders: before.oldAccounts.map((a) => a.provider).sort(),
    personalAccountProviders: before.personalAccounts.map((a) => a.provider).sort() }
  if (blocked) return { ...base, state: 'blocked', reason: blocked }
  if (!allowWrite) return { ...base, state: 'ready', readOnly: true }
  const receiptPath = args[receiptIndex + 1]!
  const prepared = { ...base, state: 'prepared', readOnly: false }
  await writeFile(receiptPath, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const oldDiscord = before.oldAccounts.find((a) => a.provider === 'discord')!
  const deleted = await db.delete(accounts).where(and(eq(accounts.userId, input.oldUserId),
    eq(accounts.provider, 'discord'), eq(accounts.providerAccountId, oldDiscord.providerAccountId)))
  // A non-one result is ambiguous. The prepared receipt prevents blind replay.
  if (deleted.rowsAffected !== 1) return { ...prepared, state: 'ambiguous', reason: 'delete_count_not_one', rowsAffected: deleted.rowsAffected }
  const after = await snapshot(input)
  const verified = verifyDiscordUnlink(before, after)
  const result = { ...base, state: verified ? 'applied' : 'ambiguous', readOnly: false,
    rowsAffected: deleted.rowsAffected, oldDiscordRemaining: after.oldAccounts.filter((a) => a.provider === 'discord').length,
    personalDiscordCount: after.personalAccounts.filter((a) => a.provider === 'discord').length,
    personalPurchaseIdsAfter: after.personalPurchases.map((p) => p.id).sort(), verified }
  await writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDiscordUnlink(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result))
    if (result.state !== 'applied' && result.state !== 'ready') process.exitCode = 1
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ state: 'failed_or_ambiguous', error: error instanceof Error ? error.message : 'unknown_error' }))
    process.exitCode = 1
  }).finally(() => closeDatabasePool())
}
