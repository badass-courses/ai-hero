import type { ContactProfileSyncReceipt } from './drovr-contact-profile-sync'
import { mapDrovrShadowFact, type DrovrShadowEvent } from './drovr-shadow-emitter'
import type { ContactEventRecord } from './types'
import { VALUE_PATH_LINK_REISSUE_EVERY_DAYS } from './value-path-link-anchor'

export type ScannedContactEvent = { id: string; contactId: string; eventType: string; occurredAt: string }
export type ReconcileRowCursor = { at: string; id: string }
/** One bounded page of a frozen scan. The timestamp watermark never crosses
 * unfinished work, including a timestamp tie; this tuple makes the tie resume
 * rather than reprocess the same prefix forever. Reuses the existing row.
 */
export type ReconcileProgress = {
 base: string
 through: string
 writtenThrough: string
 phase: 'overlap' | 'rotations' | 'fresh'
 after?: ReconcileRowCursor
}
export type ContactSyncReconcilePorts = {
 now(): Date
 readWatermark(): Promise<string | undefined>
 readProgress(): Promise<ReconcileProgress | undefined>
 scanChanges(args: { scope: 'fresh' | 'overlap'; writtenAfter?: string; writtenThrough?: string; after: string; through: string; limit: number; pageAfter?: ReconcileRowCursor }): Promise<ScannedContactEvent[]>
 rotatedContacts(args: { after: string; through: string; limit: number; pageAfter?: ReconcileRowCursor }): Promise<{ contactId: string; at: string }[]>
 syncContact(contactId: string): Promise<'sent' | 'skipped' | 'deferred'>
 syncOffer?(contactId: string): Promise<'sent' | 'skipped' | 'deferred'>
 resendStops(events: ScannedContactEvent[]): Promise<void>
 heartbeat(syncedThrough: string): Promise<void>
 /** Progress and watermark must be saved together, also on equal watermark. */
 writeWatermark(watermark: string, progress?: ReconcileProgress): Promise<void>
}
export type ContactSyncReconcileReceipt = {
 status: 'synced' | 'partial'
 syncedThrough: string
 contacts: number
 rotated: number
 events: number
 failed?: string[]
 cursor?: ReconcileProgress
}
export const CONTACT_SYNC_STOP_EVENT_TYPES: ReadonlySet<string> = new Set(['contact.unsubscribed', 'contact.bounced', 'contact.complained'])
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * HOUR_MS
const iso = (ms: number) => new Date(ms).toISOString()
const compareId = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const compareRow = (left: ReconcileRowCursor, right: ReconcileRowCursor) => Date.parse(left.at) - Date.parse(right.at) || compareId(left.id, right.id)
type RepairRow = ReconcileRowCursor & { contactId: string; kind: 'profile' | 'offer'; event?: ScannedContactEvent }

export async function runContactSyncReconcile(ports: ContactSyncReconcilePorts, options: {
 limit?: number; maxContacts?: number; maxContactsHard?: number; overlapMs?: number; lateWriteWindowMs?: number; settleMs?: number
} = {}): Promise<ContactSyncReconcileReceipt> {
 const limit = options.limit ?? 5000
 const hardContactBudget = options.maxContactsHard ?? 900
 const contactBudget = Math.min(options.maxContacts ?? 400, hardContactBudget)
 if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(contactBudget) || contactBudget < 1) throw new Error('ReconcileBounds: you requested a scan, and it failed because its row/contact bounds are invalid. Accepted: positive whole-number limits. Fix: restore bounded scan options. Debug: inspect the reconcile configuration.')
 const now = ports.now().getTime()
 const planned = iso(now - (options.settleMs ?? 2 * MINUTE_MS))
 const watermark = await ports.readWatermark()
 const last = watermark ?? iso(Date.parse(planned) - (options.overlapMs ?? HOUR_MS))
 const saved = await ports.readProgress()
 let progress: ReconcileProgress | undefined = saved ? structuredClone(saved) : { base: last, through: planned, writtenThrough: iso(Math.floor(now / 1000) * 1000 - 1), phase: watermark ? 'overlap' : 'rotations' }
 if (!['overlap', 'rotations', 'fresh'].includes(progress.phase) || ![progress.base, progress.through, progress.writtenThrough].every(value => Number.isFinite(Date.parse(value))) || Date.parse(progress.base) > Date.parse(last) || Date.parse(progress.through) < Date.parse(last) || progress.after && (!Number.isFinite(Date.parse(progress.after.at)) || typeof progress.after.id !== 'string')) throw new Error('ReconcileProgress: you resumed a scan, and it failed because its frozen checkpoint is invalid. Accepted: an ordered timestamp/id cursor inside the saved window. Fix: inspect the checkpoint before retrying. Debug: compare base, through and watermark; never skip an uncovered tie.')
 const work = new Set<string>()
 const contacts = new Set<string>()
 const rotated = new Set<string>()
 const failed = new Set<string>()
 const stops: ScannedContactEvent[] = []
 let eventCount = 0
 let claim = last
 let softBoundaryAt: string | undefined
 for (let phaseNumber = 0; phaseNumber < 3 && progress; phaseNumber++) {
  const phase: ReconcileProgress['phase'] = progress.phase
  const checkpoint = progress
  const prefixClaim = async (nextAt: string) => {
   let boundary = nextAt
   if (phase === 'rotations') {
    // Rotation work is processed before fresh work, but an unfinished
    // rotation must not conceal a still-earlier fresh input. Peek only;
    // this run stops here, so the memoized fresh-scan ID is not reused.
    const [firstFresh] = await ports.scanChanges({ scope: 'fresh', after: checkpoint.base, through: checkpoint.through, writtenThrough: checkpoint.writtenThrough, limit: 1 })
    if (firstFresh && Date.parse(firstFresh.occurredAt) < Date.parse(boundary)) boundary = firstFresh.occurredAt
   }
   return iso(Math.max(Date.parse(last), Date.parse(boundary) - 1))
  }
  let rows: RepairRow[]
  if (phase === 'rotations') {
   rows = (await ports.rotatedContacts({ after: progress.base, through: progress.through, limit: Math.min(limit, hardContactBudget), pageAfter: progress.after })).map(row => ({ at: row.at, id: row.contactId, contactId: row.contactId, kind: 'profile' as const }))
  } else {
   rows = (await ports.scanChanges({ scope: phase, after: phase === 'fresh' ? progress.base : iso(Date.parse(progress.base) - (options.lateWriteWindowMs ?? 48 * HOUR_MS)), through: phase === 'fresh' ? progress.through : progress.base, ...(phase === 'overlap' ? { writtenAfter: progress.base } : {}), writtenThrough: progress.writtenThrough, limit, pageAfter: progress.after })).map(event => ({ at: event.occurredAt, id: event.id, contactId: event.contactId, kind: event.eventType === 'coupon.issued' || event.eventType === 'contact.offer.issued' ? 'offer' as const : 'profile' as const, event }))
  }
  rows.sort(compareRow)
  const page = rows.slice(0, limit)
  const tasks = new Map<string, RepairRow>()
  const plannedContacts = new Set(contacts)
  const selected: RepairRow[] = []
  let stopCount = stops.length
  for (const row of page) {
   const key = `${row.kind}:${row.contactId}`
   const newWork = !work.has(key) && !tasks.has(key)
   const nextStops = stopCount + (row.event && CONTACT_SYNC_STOP_EVENT_TYPES.has(row.event.eventType) ? 1 : 0)
   // Actual profile+offer invocations, not contacts+offers (which double
   // counted offer-only contacts). Reserve overhead for stop-envelope invokes.
   if (!plannedContacts.has(row.contactId) && (plannedContacts.size >= hardContactBudget || plannedContacts.size >= contactBudget && row.at !== softBoundaryAt) || newWork && work.size + tasks.size + 1 > 900 || work.size + tasks.size + Number(newWork) + Math.ceil(nextStops * 2 / 100) > 950) break
   plannedContacts.add(row.contactId)
   if (plannedContacts.size === contactBudget && !softBoundaryAt) softBoundaryAt = row.at
   if (newWork) tasks.set(key, row)
   selected.push(row); stopCount = nextStops
  }
  const byContact = new Map<string, RepairRow[]>()
  for (const task of tasks.values()) byContact.set(task.contactId, [...(byContact.get(task.contactId) ?? []), task])
  const answers = new Map<string, 'sent' | 'skipped' | 'deferred' | { error: unknown }>()
  const groups = [...byContact.values()]
  for (let start = 0; start < groups.length; start += 10) await Promise.all(groups.slice(start, start + 10).map(async group => {
   // A profile allocation precedes its same-contact offer repair.
   group.sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'profile' ? -1 : 1)
   for (const row of group) {
    const key = `${row.kind}:${row.contactId}`
    try {
     if (row.kind === 'offer' && !ports.syncOffer) throw new Error('OfferRepair: you claimed a coupon row, and it failed because live offer repair is unavailable. Accepted: a live offer-only resync. Fix: restore the repair port. Debug: inspect the reconcile wiring.')
     answers.set(key, await (row.kind === 'profile' ? ports.syncContact(row.contactId) : ports.syncOffer!(row.contactId)))
    } catch (error) { answers.set(key, { error }) }
   }
  }))
  const covered: RepairRow[] = []
  let firstError: unknown
  for (const row of selected) {
   const key = `${row.kind}:${row.contactId}`
   const answer = work.has(key) ? 'sent' : answers.get(key)
   if (answer !== 'sent' && answer !== 'skipped') {
    failed.add(row.contactId)
    if (answer && typeof answer === 'object') firstError = answer.error
    break
   }
   covered.push(row)
   contacts.add(row.contactId)
   if (phase === 'rotations') rotated.add(row.contactId)
   if (row.event) { eventCount++; if (CONTACT_SYNC_STOP_EVENT_TYPES.has(row.event.eventType)) stops.push(row.event) }
  }
  for (const [key, answer] of answers) {
   if (answer === 'sent' || answer === 'skipped') work.add(key)
   else failed.add(tasks.get(key)!.contactId)
  }
  if (covered.length) { const row = covered[covered.length - 1]!; progress.after = { at: row.at, id: row.id } }
  if (failed.size) {
   if (phase !== 'overlap') claim = await prefixClaim(selected[covered.length]!.at)
   if (!covered.length && firstError !== undefined && Date.parse(claim) <= Date.parse(last)) throw firstError
   break
  }
  const finished = covered.length === rows.length
  if (finished) {
   if (phase === 'fresh') { claim = progress.through; progress = undefined; break }
   progress = { base: progress.base, through: progress.through, writtenThrough: progress.writtenThrough, phase: phase === 'overlap' ? 'rotations' : 'fresh' }
   continue
  }
  if (phase !== 'overlap' && covered.length) claim = await prefixClaim(rows[covered.length]!.at)
  break
 }
 // Only an answered stop batch (or a durable/superseded receipt) can cross
 // the watermark. A resend failure leaves both checkpoint and claim unsaved.
 await ports.resendStops(stops)
 await ports.heartbeat(claim)
 if (progress) await ports.writeWatermark(claim, progress)
 else await ports.writeWatermark(claim)
 return { status: progress || failed.size ? 'partial' : 'synced', syncedThrough: claim, contacts: contacts.size, rotated: rotated.size, events: eventCount, ...(failed.size ? { failed: [...failed].sort() } : {}), ...(progress ? { cursor: progress } : {}) }
}

/** The live mapping, retaining original immutable stop keys. */
export async function stopFactsFor(repository: { findContactEventsByType(contactId: string, eventType: string): Promise<ContactEventRecord[]> | ContactEventRecord[] }, stops: readonly ScannedContactEvent[]): Promise<DrovrShadowEvent[]> {
 const facts: DrovrShadowEvent[] = []
 for (const stop of stops) {
  const records = await repository.findContactEventsByType(stop.contactId, stop.eventType)
  const record = records.find(candidate => candidate.id === stop.id)
  if (record) facts.push(...mapDrovrShadowFact({ kind: 'contact-event', event: record }))
 }
 return facts
}
const BENIGN_SYNC_SKIPS: ReadonlySet<string> = new Set(['contact-missing', 'synthetic-principal', 'no-sending-journey', 'contact-email-missing', 'unchanged', 'profile-not-issued', 'hash-migrated'])
export function reconcileSyncOutcome(contactId: string, receipt: ContactProfileSyncReceipt): 'sent' | 'skipped' | 'deferred' {
 if (receipt.status === 'sent') return 'sent'
 if (receipt.status === 'deferred' || receipt.status === 'awaiting-proof') return 'deferred'
 if (BENIGN_SYNC_SKIPS.has(receipt.reason)) return 'skipped'
 throw new Error(`profile sync for ${contactId} was not pushed: ${receipt.reason}`)
}
export function linkRotationRanges(args: { after: string; through: string }, steps = 5): { after: string; through: string }[] {
 const stepMs = VALUE_PATH_LINK_REISSUE_EVERY_DAYS * DAY_MS
 return Array.from({ length: steps }, (_, index) => ({ after: iso(Date.parse(args.after) - (index + 1) * stepMs), through: iso(Date.parse(args.through) - (index + 1) * stepMs) }))
}
