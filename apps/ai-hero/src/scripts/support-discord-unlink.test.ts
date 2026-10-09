import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { guardDiscordUnlink, verifyDiscordUnlink } from './support-discord-unlink'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const input = {
  runId: 'run', conversationId: 'cnv_test', approvalReference: 'approved', expectedInboundId: 'msg_test',
  oldUserId: '11111111-1111-4111-8111-111111111111', oldEmail: 'old@example.com',
  personalUserId: '22222222-2222-4222-8222-222222222222', personalEmail: 'new@example.com',
  providerAccountSha256: hash('discord-target'), expectedPersonalPurchaseIds: ['purch_a'],
}
const before = {
  oldEmail: input.oldEmail, personalEmail: input.personalEmail,
  oldAccounts: [{ userId: input.oldUserId, provider: 'discord', providerAccountId: 'discord-target' }],
  personalAccounts: [{ userId: input.personalUserId, provider: 'github', providerAccountId: 'gh-1' }],
  oldPurchases: [], personalPurchases: [{ id: 'purch_a', userId: input.personalUserId, status: 'Valid' }],
}

describe('guarded support Discord unlink', () => {
  it('accepts only the exact verified identity, link and active purchase set', () => {
    expect(guardDiscordUnlink(input, before)).toBeNull()
    expect(guardDiscordUnlink({ ...input, providerAccountSha256: hash('other') }, before)).toBe('old_discord_mismatch')
    expect(guardDiscordUnlink(input, { ...before, oldPurchases: [...before.personalPurchases] })).toBe('old_account_has_purchases')
    expect(guardDiscordUnlink(input, { ...before, personalAccounts: [...before.personalAccounts, { userId: input.personalUserId, provider: 'discord', providerAccountId: 'other' }] })).toBe('personal_discord_collision')
    expect(guardDiscordUnlink(input, { ...before, personalPurchases: [] })).toBe('personal_purchase_mismatch')
    expect(guardDiscordUnlink(input, { ...before, personalEmail: 'other@example.com' })).toBe('identity_mismatch')
    expect(guardDiscordUnlink(input, { ...before, personalPurchases: [{ ...before.personalPurchases[0]!, status: 'Refunded' }] })).toBe('personal_purchase_not_active')
  })
  it('requires exactly one removed account and unchanged identity/purchase/other-provider state', () => {
    const after = { ...before, oldAccounts: [] }
    expect(verifyDiscordUnlink(before, after)).toBe(true)
    expect(verifyDiscordUnlink(before, before)).toBe(false)
    expect(verifyDiscordUnlink(before, { ...after, personalAccounts: [] })).toBe(false)
    expect(verifyDiscordUnlink(before, { ...after, personalPurchases: [] })).toBe(false)
    expect(verifyDiscordUnlink(before, { ...after, oldEmail: 'changed@example.com' })).toBe(false)
  })
})
