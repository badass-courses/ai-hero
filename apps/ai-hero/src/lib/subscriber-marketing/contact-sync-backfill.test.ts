import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { expect, it, vi } from 'vitest'
import { runContactSyncBackfill, runContactSyncBackfillPage, type BackfillCursor, type BackfillPorts, type BackfillRow } from './contact-sync-backfill'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import { approvalDigest } from './contact-sync-backfill-approval'
import { JOURNEY_OWNER_ASSIGNED_EVENT_TYPE } from './drovr-ownership'
import { DOI_REQUESTED_EVENT_TYPE } from './drovr-doi-signup'
import { BACKFILL_DUNGEON_FLAG, BACKFILL_DUNGEON_CONFIRMATION } from './contact-sync-backfill-dungeon'
const frozen = Date.parse('2032-01-01T00:00:00.000Z')
function world(owners = 3, extra: BackfillRow[] = [], noEmail: string[] = []) {
 const rows = [...Array.from({ length: owners }, (_, index) => ({ id: `row-${String(index).padStart(5, '0')}`, contactId: `contact-${index}`, eventType: JOURNEY_OWNER_ASSIGNED_EVENT_TYPE, providerEventId: `drovr-owner:contact-${index}:value-path-skills-course`, occurredAt: new Date(frozen - 86400000).toISOString() })), ...extra].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
 const stamps: { contactId: string; now: string }[] = []
 const grants = new Map<string, string>()
 let tokenId = 0
 const versions = createMemoryContactProfileVersionStore({ now: () => new Date(frozen).toISOString() })
 const persist = vi.fn(async (_events: DrovrShadowEvent[]) => {})
 const ports: BackfillPorts = {
  persistEvents: persist,
  now: () => frozen,
  countEvents: vi.fn(async type => rows.filter(row => row.eventType === type).length),
  scanEvents: async ({ eventType, afterOccurredAt, afterId, limit }) => rows.filter(row => row.eventType === eventType && (!afterOccurredAt || row.occurredAt > afterOccurredAt || row.occurredAt === afterOccurredAt && row.id > (afterId ?? ''))).slice(0, limit),
  snapshot: async (contactId, now) => { stamps.push({ contactId, now }); return { occurredAt: now, profile: { email: noEmail.includes(contactId) ? '' : 'learner@example.test', firstName: null, holds: [] }, links: [], offers: [] } },
  versionFor: versions.versionFor,
  liveStopFacts: async list => list.map(row => ({ tenantId: 'org-aihero' as const, contactId: row.contactId, journeyId: 'contact-directory' as const, type: row.eventType as DrovrShadowEvent['type'], occurredAt: row.occurredAt, idempotencyKey: `live:${row.id}` })),
  approvals: { issue: async binding => { const token = `token-${++tokenId}`; grants.set(token, approvalDigest(binding)); return token }, consume: async (token, binding) => { if (grants.get(token) !== approvalDigest(binding)) return false; grants.delete(token); return true } },
 }
 return { ports, stamps, persist }
}
async function drain(ports: BackfillPorts, pageSize: number) {
 let cursor: BackfillCursor = { phase: 'owners' }
 const pages: Awaited<ReturnType<typeof runContactSyncBackfillPage>>[] = []
 for (let guard = 0; cursor.phase !== 'done' && guard < 1000; guard++) { const page = await runContactSyncBackfillPage(ports, cursor, { pageSize }); pages.push(page); cursor = page.next }
 return pages
}
it('refuses a missing canary field even with an otherwise valid count', async () => {
 const { ports } = world(4)
 await expect(runContactSyncBackfill({ event: { data: { dryRunCount: 4 } }, step: { run: async (_id, action) => action(), sendEvent: async () => {} }, env, ports })).rejects.toThrow('BackfillCanary:')
})
it('a failed durable page capture cannot publish or grant a continuation', async () => {
 const { ports, persist } = world(4)
 persist.mockRejectedValue(new Error('synthetic capture failure'))
 const sendEvent = vi.fn(async () => {})
 await expect(runContactSyncBackfill({ event: { data: { canary: true, dryRunCount: 4 } }, step: { run: async (_id, action) => action(), sendEvent }, env, ports })).rejects.toThrow('synthetic capture failure')
 expect(sendEvent).not.toHaveBeenCalled()
})
it('stamps every contact at a distinct monotonic instant, including across frozen-clock pages', async () => {
 const { ports, stamps } = world(1000)
 await drain(ports, 100)
 const times = stamps.map(stamp => Date.parse(stamp.now))
 expect(times).toHaveLength(1000)
 expect(new Set(times).size).toBe(1000)
 expect(times).toEqual([...times].sort((a, b) => a - b))
 expect(times[0]).toBe(frozen)
})
it('walks every phase and keeps the live stop keys, including contacts without an owner', async () => {
 const { ports } = world(2, [{ id: 'stop', contactId: 'unowned', eventType: 'contact.unsubscribed', occurredAt: new Date(frozen).toISOString() }])
 const pages = await drain(ports, 10)
 expect(pages.map(page => page.phase)).toEqual(['owners', 'double-opt-in', 'contact.unsubscribed', 'contact.bounced', 'contact.complained'])
 expect(pages.at(-1)!.next).toEqual({ phase: 'done' })
 expect(pages.flatMap(page => page.events).find(event => event.idempotencyKey === 'live:stop')).toMatchObject({ contactId: 'unowned', type: 'contact.unsubscribed' })
})
it('resumes after the exact row and carries the next stamp forward', async () => {
 const { ports } = world(5)
 const first = await runContactSyncBackfillPage(ports, { phase: 'owners' }, { pageSize: 2 })
 const second = await runContactSyncBackfillPage(ports, first.next, { pageSize: 2 })
 expect(first.next).toMatchObject({ phase: 'owners', afterId: first.rows.at(-1)!.id, nextStampMs: frozen + 2 })
 expect(second.rows.map(row => row.id)).not.toContain(first.rows[0]!.id)
})
it('never profiles a synthetic principal, retired journey or missing email', async () => {
 const extra = ['synthetic_x', 'retired'].map((id, index) => ({ id, contactId: id, eventType: JOURNEY_OWNER_ASSIGNED_EVENT_TYPE, providerEventId: `drovr-owner:${id}:${index ? 'retired' : 'shadow-newsletter'}`, occurredAt: new Date(frozen).toISOString() }))
 const { ports } = world(2, extra, ['contact-1'])
 const pages = await drain(ports, 10)
 expect(pages.flatMap(page => page.events).map(event => event.contactId)).toEqual(['contact-0'])
})
it('includes double-opt-in directory contacts, with replay-stable versions and keys', async () => {
 const { ports } = world(1, [{ id: 'doi', contactId: 'doi-contact', eventType: DOI_REQUESTED_EVENT_TYPE, occurredAt: new Date(frozen).toISOString() }])
 const first = (await drain(ports, 10)).flatMap(page => page.events)
 expect(first.map(event => event.contactId)).toEqual(['contact-0', 'doi-contact'])
 expect((await drain(ports, 10)).flatMap(page => page.events).map(event => event.idempotencyKey)).toEqual(first.map(event => event.idempotencyKey))
})
// Legacy planner contracts are exercised only under an explicit test override;
// the production entry point is dungeoned by default, not declared repaired.
const env = { AIH_DROVR_PROFILE_SYNC: 'true', [BACKFILL_DUNGEON_FLAG]: BACKFILL_DUNGEON_CONFIRMATION }
const step = () => ({ run: async (_id: string, fn: () => Promise<unknown>) => fn(), sendEvent: vi.fn(async (_id: string, _data: unknown) => {}) })
it('requires an actual count and one-contact canary before accepting a manual bounded phase', async () => {
 const { ports } = world(4)
 const first = step()
 const dry = await runContactSyncBackfill({ event: { data: { dryRun: true } }, step: first, ports, env })
 expect(dry).toEqual({ status: 'dry-run', rows: 4 })
 expect(first.sendEvent).not.toHaveBeenCalled()
 const canary = await runContactSyncBackfill({ event: { data: { canary: true, dryRunCount: 4 } }, step: first, ports, env })
 expect(canary).toMatchObject({ status: 'paused', contacts: 1, pages: 1 })
 if (canary.status !== 'paused') throw new Error('canary did not pause')
 const next = step()
 const receipt = await runContactSyncBackfill({ event: { data: { canary: true, dryRunCount: 4, canaryConfirmed: true, approvalToken: canary.approvalToken, cursor: canary.cursor, maxPages: 1, stopBeforePhase: 'double-opt-in' } }, step: next, ports, env, pageSize: 50 })
 expect(receipt).toMatchObject({ status: 'paused', contacts: 3, pages: 1, cursor: { phase: 'double-opt-in' } })
 expect(next.sendEvent).toHaveBeenCalledTimes(1)
 expect(JSON.stringify(next.sendEvent.mock.calls)).not.toContain('backfill-requested')
})
it('flags alone cannot bypass the canary and a changed count refuses terminally', async () => {
 const { ports } = world()
 await expect(runContactSyncBackfill({ event: { data: { canary: true, dryRunCount: 0, canaryConfirmed: true, cursor: { phase: 'owners' } } }, step: step(), ports, env })).rejects.toMatchObject({ name: 'NonRetriableError' })
 await expect(runContactSyncBackfill({ event: { data: { canary: true, dryRunCount: 0 } }, step: step(), ports, env })).rejects.toThrow('BackfillCountChanged:')
})
it('disabled runs do not read or publish, and invalid limits refuse terminally', async () => {
 const { ports } = world()
 const read = vi.spyOn(ports, 'scanEvents')
 await expect(runContactSyncBackfill({ event: { data: {} }, step: step(), ports, env: {} })).rejects.toThrow('BackfillDungeon:')
 expect(read).not.toHaveBeenCalled()
 await expect(runContactSyncBackfill({ event: { data: { canary: true, dryRunCount: 3, maxPages: 0 } }, step: step(), ports, env })).rejects.toMatchObject({ name: 'NonRetriableError' })
})
