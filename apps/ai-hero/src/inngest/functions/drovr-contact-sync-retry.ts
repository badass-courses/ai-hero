import { CONTACT_SYNC_RETRY_EVENT, deliverEventNameFor } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { DROVR_SEND_RETRIES, isOutboxStop, outboxEntryForEvent } from '@/lib/subscriber-marketing/drovr-outbox'
import { runPacedSend, waitForBulkSlot } from '@/lib/subscriber-marketing/drovr-bulk-pace'
import { BulkPaceYieldError } from '@/lib/subscriber-marketing/drovr-bulk-permit'
import { createDirectoryBirth, runContactSyncStragglerRetry } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
import { ownRetryEvents, readRetryDispositionLive, retryEventIdentity, type OwnedRetryEvent } from '@/lib/subscriber-marketing/contact-sync-retry-owned-events'
import { isUncappedOfferRetry, retryPaceClass, retryDeliverySource, retryOutboxSource, retryStepKey, routeContactSyncRetry, type RetryData } from '@/lib/subscriber-marketing/contact-sync-retry-route'
import { profileVersionForRefresh } from '@/lib/subscriber-marketing/contact-sync-offer-refresh'
import { proveRetryAcknowledgement, retryProofRowsLive, RETRY_PROOF_MAX_REFERENCES } from '@/lib/subscriber-marketing/contact-sync-retry-acknowledgement'
import { HeldBatchContinuationError } from '@/lib/subscriber-marketing/contact-sync-held-batch'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import type { GetStepTools } from 'inngest'
import type { DrovrBatchOutcome } from '@/lib/subscriber-marketing/drovr-shadow-delivery'

/** All retry items are already normalized/admitted. Never fan them out again,
 * change their source, or retire a delivered receipt on a final real failure. */
export async function captureFailedContactSyncRetry(data: RetryData, error: unknown) {
 const { captureDrovrOutboxLive } = await import('@/lib/subscriber-marketing/drovr-outbox-live')
 const source = retryOutboxSource(data)
 const stamp = data.firstFailedAt ? Date.parse(data.firstFailedAt) : undefined
 const entries = [...data.items, ...(data.carry ?? [])].map(({ event }) => outboxEntryForEvent(event, source, stamp !== undefined && Number.isFinite(stamp) ? { sentAt: stamp } : {}))
 if (!entries.length) return
 const answer = await captureDrovrOutboxLive(entries, error)
 if (answer.status !== 'outboxed') throw new Error('RetryCapture: you exhausted a retry run, and it failed because durable capture is unavailable. Accepted: every unfinished immutable item retained. Fix: restore the outbox and reissue the original request. Debug: keep the failed run and its acknowledgement metadata.')
}

/** One item per physical run bounds even cold birth + redelivery + repeated
 * booking expiry. Continuations retain the original acknowledgement and all
 * unresolved members. Capped calls run in the existing isolated class worker. */
export async function runPacedContactSyncRetry({ event, step, runId, attempt = 0, maxAttempts = DROVR_SEND_RETRIES + 1 }: { event: { data: RetryData }; step: GetStepTools<typeof inngest>; runId: string; attempt?: number; maxAttempts?: number }) {
 const [{ db }, { env }, { log }, { deliverBatchOrThrow }, { drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID }, { DrizzleCaptureMarketingRepository }, { findContactKitIdentity }, { createDrizzleContactProfileVersionStore }, { contactSyncSendOrOutbox, settleOrHoldStragglerStops }, { settleDrovrOutboxLive, rejectDrovrOutboxLive, drovrOutboxTargetFromEnv }] = await Promise.all([
  import('@/db'), import('@/env.mjs'), import('@/server/logger'), import('@/lib/subscriber-marketing/drovr-shadow-delivery'), import('@/lib/subscriber-marketing/drovr-shadow-emitter'), import('@/lib/subscriber-marketing/drizzle-capture-repository'), import('@/lib/subscriber-marketing/contact-kit-identity-drizzle'), import('@/lib/subscriber-marketing/contact-profile-version-drizzle'), import('@/lib/subscriber-marketing/drovr-outbox-contact-sync'), import('@/lib/subscriber-marketing/drovr-outbox-live'),
 ])
 const uncappedOffer = isUncappedOfferRetry(event.data)
 const kind = retryPaceClass(event.data)
 const source = retryDeliverySource(event.data)
 if (!uncappedOffer) { event.data.paceClass = kind; event.data.deliverySource = source }
 const clampAt = await step.run('retry-original-clock', async () => {
  const value = event.data.firstFailedAt ? Date.parse(event.data.firstFailedAt) : Date.now()
  if (!Number.isFinite(value)) throw new Error('RetryClock: you resumed delivery, and it failed because the original clock is invalid. Accepted: the original finite UTC instant. Fix: restore the request metadata without moving the birth clock. Debug: compare the capture and retry request.')
  return value
 })
 event.data.firstFailedAt = new Date(clampAt).toISOString()
 const permissionActive = async () => !event.data.heldBatchRelease || (await import('@/lib/subscriber-marketing/contact-sync-held-batch-live')).releasedRetryPermissionLive(event.data)
 if (!await permissionActive()) {
  try { await log.warn('drovr.contact_sync.retry_permission_inactive', { anchorKey: event.data.heldBatchRelease?.anchorKey, detail: new HeldBatchContinuationError({ reason: 'the original operator permission is held, completed or replaced; no automatic requeue is authorized' }).message }) } catch { /* logging cannot reopen the coordinator */ }
  return { status: 'held' as const, remaining: event.data.items.length + (event.data.carry?.length ?? 0), reason: 'unproven-delivery' as const }
 }
 const outboxSource = retryOutboxSource(event.data)
 const owned = new Map<string, OwnedRetryEvent>()
 const park = async (input: { anchor: DrovrShadowEvent; data: RetryData; reason: 'outboxed' | 'unproven-delivery' }) => (await import('@/lib/subscriber-marketing/contact-sync-held-batch-live')).parkContactSyncRetryLive(input)
 const proof = async (phase: 'admission' | 'terminal') => {
  if (!await permissionActive()) return { proved: false as const, reason: 'the original operator permission is no longer active' }
  const target = drovrOutboxTargetFromEnv()
  if (!target) throw new HeldBatchContinuationError({ reason: 'the acknowledgement target is unavailable' })
  return proveRetryAcknowledgement({ data: event.data, target, phase, rows: retryProofRowsLive })
 }
 const entriesFor = (events: DrovrShadowEvent[], at = clampAt) => events.map(item => outboxEntryForEvent(item, outboxSource, { sentAt: at }))
 const config = () => {
  const ingestUrl = env.DROVR_SHADOW_INGEST_URL
  const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID)
  if (!ingestUrl || !apiKey) throw new Error('RetryConfig: you requested delivery, and it failed because drovr is not configured. Accepted: the authority ingest URL and key. Fix: restore configuration. Debug: inspect presence, never log credentials.')
  return { ingestUrl, apiKey }
 }
 const recordFor = (events: DrovrShadowEvent[]) => {
  const record = events[0] && owned.get(retryEventIdentity(events[0]))
  if (!record) throw new Error('RetryOwnership: you resumed a POST, and it failed because its scoped ownership record is missing. Accepted: immutable ownership before any booking. Fix: restore the original ownership step. Debug: inspect the full scoped key without rebasing the body or clock.')
  return record
 }
 // Replace the old delivered-only check first. Fresh family-gate waits
 // still need the healthy continuation contract, not a manual held anchor.
 const disposition = async (record: OwnedRetryEvent): Promise<DrovrBatchOutcome | undefined> => !await permissionActive() ? { accepted: 0, rejected: 0, retainedHeld: 1 } : readRetryDispositionLive(record, { gates: false })
 const recordFinalRefusals = async (answer: DrovrBatchOutcome) => {
  for (const refusal of answer.refused ?? []) {
   const entry = outboxEntryForEvent(refusal.event, outboxSource)
   if (!isOutboxStop(entry)) await rejectDrovrOutboxLive([entry], `RetryRefusal: you sent retained work, and it failed because drovr refused it with ${refusal.httpStatus}. Accepted: immutable scoped facts. Fix: inspect the refusal and reissue corrected work under a new key. Debug: ${(JSON.stringify(refusal.problem) ?? 'no receiver problem body').slice(0, 1000)}`, refusal.httpStatus)
  }
  return answer
 }
 const deliver = (events: DrovrShadowEvent[], index = attempt) => {
  const record = recordFor(events)
  const at = record.clampAt
  const entries = entriesFor(events, at)
  return contactSyncSendOrOutbox({ attempt: index, maxAttempts: uncappedOffer ? maxAttempts : DROVR_SEND_RETRIES + 1 }, undefined, { source: outboxSource, clampAt: at })(events, async () => {
   const retained = await disposition(record)
   if (retained) return retained
   const answer = await settleOrHoldStragglerStops(events, await recordFinalRefusals(await deliverBatchOrThrow({ events, config: config(), deferNotLive: true, clampAt: at })))
   // Profile settlement waits for its derived refresh command below.
   if (answer.accepted > 0 && !answer.deferred?.length && !answer.rejected && events[0]!.type !== 'contact.profile.updated') await settleDrovrOutboxLive(entries, 'delivered by straggler')
   return answer
  })
 }
 const pace = (id: string) => waitForBulkSlot(step, id, kind)
 const pacedDeliver = async (id: string, events: DrovrShadowEvent[]) => {
  const retained = await step.run(`${id}:disposition`, () => disposition(recordFor(events)))
  if (retained) return retained
  return uncappedOffer ? await step.run(`${id}:post`, () => deliver(events)) : runPacedSend(step, id, pace, index => deliver(events, index))
 }
 const repository = new DrizzleCaptureMarketingRepository(db)
 const pacedBirth = async (id: string, ids: string[]) => {
  const births = await step.run(`${id}:facts`, async () => {
   const facts: DrovrShadowEvent[] = []
   await createDirectoryBirth({ findContactById: key => repository.findContactById(key), kitSubscriberIdFor: async key => (await findContactKitIdentity(db, key)).kitSubscriberId, deliver: async events => { facts.push(...events) } })(ids)
   return ownRetryEvents(facts, outboxSource, clampAt)
  })
  let accepted = 0
  for (const record of births) {
   const birthId = `${id}:${retryStepKey(record.event)}`
   const retained = await step.run(`${birthId}:disposition`, () => disposition(record))
   if (retained?.alreadyDelivered) continue
   if (retained) return retained
   const events = [record.event]
   const entries = entriesFor(events, record.clampAt)
   const post = (index: number) => contactSyncSendOrOutbox({ attempt: index, maxAttempts: uncappedOffer ? maxAttempts : DROVR_SEND_RETRIES + 1 }, undefined, { source: outboxSource, clampAt: record.clampAt })(events, async () => {
    const retained = await disposition(record)
    if (retained) return retained
    const answer = await recordFinalRefusals(await deliverBatchOrThrow({ events, config: config(), clampAt: record.clampAt }))
    if (answer.accepted > 0 && !answer.rejected && !answer.deferred?.length) await settleDrovrOutboxLive(entries, 'directory birth delivered by straggler')
    return answer
   })
   const answer = uncappedOffer ? await step.run(`${birthId}:post`, () => post(attempt)) : await runPacedSend(step, birthId, pace, post)
   if (answer.outboxed || answer.retainedHeld || answer.retainedRejected || answer.rejected || answer.deferred?.length || (!answer.accepted && !answer.alreadyDelivered)) return answer
   accepted += answer.accepted
  }
  return { accepted, rejected: 0, ...(births.length && !accepted ? { alreadyDelivered: true } : {}) }
 }
 try {
  const receipt = await runContactSyncStragglerRetry({ event, step, env: process.env, now: () => Date.now(), runId, warn: log.warn, deliver, birth: async ids => { await pacedBirth('directory-birth', ids) }, pacedDeliver, pacedBirth,
   holdBatch: park,
   proveComplete: () => proof('terminal'),
   beforeDeliver: async () => {
    const members = [...event.data.items, ...(event.data.carry ?? [])]
    const records = await step.run('own-retry-input', () => ownRetryEvents(members.map(item => item.event), outboxSource, clampAt))
    records.forEach((record, index) => { members[index]!.event = record.event; owned.set(retryEventIdentity(record.event), record) })
    event.data.ownedKeys ??= [...new Set(records.map(record => record.outboxKey))]
    const admitted = await proof('admission')
    if (!admitted.proved) {
     const anchor = members[0]?.event
     if (anchor) await park({ anchor, data: event.data, reason: 'unproven-delivery' })
     if (!anchor) throw new HeldBatchContinuationError({ reason: admitted.reason })
     try { await log.warn('drovr.contact_sync.ack_proof_held', { detail: new HeldBatchContinuationError({ reason: admitted.reason }).message }) } catch { /* logging cannot reopen parked work */ }
     return 'held' as const
    }
    if (admitted.additionalAuthority && !event.data.heldBatchRelease && !event.data.ownedKeys.includes(admitted.additionalAuthority)) {
     if (event.data.ownedKeys.length >= RETRY_PROOF_MAX_REFERENCES) throw new HeldBatchContinuationError({ reason: 'the legacy authority proof would exceed the frozen reference budget' })
     event.data.ownedKeys.push(admitted.additionalAuthority)
    }
   },
   afterProfile: async profile => {
    const key = retryStepKey(profile)
    if (!profile.idempotencyKey.includes(':restate:')) await step.sendEvent(`refresh-offer:${key}`, { id: `offer-refresh:${key}`, name: deliverEventNameFor(source), data: { source, events: [], offerRefresh: { contactId: profile.contactId, profileVersion: profileVersionForRefresh(profile) } } })
    await step.run(`settle-profile:${key}`, () => settleDrovrOutboxLive(entriesFor([profile]), 'profile and derived refresh command durable'))
   },
   acknowledge: (id, version) => createDrizzleContactProfileVersionStore(db).acknowledge(id, version),
  })
  if (receipt.status === 'delivered' && event.data.heldBatchRelease) await step.run('complete-held-batch', async () => (await import('@/lib/subscriber-marketing/contact-sync-held-batch-live')).completeContactSyncHeldBatchLive(event.data))
  return receipt
 } catch (error) {
  if (!(error instanceof BulkPaceYieldError)) throw error
  await step.sleep('retry-capacity-handoff', '60s')
  await step.sendEvent('retry-capacity-requeue', routeContactSyncRetry({ name: CONTACT_SYNC_RETRY_EVENT, id: `contact-sync-capacity:${runId}`, ts: Date.now(), data: event.data }))
  return { status: 'capacity-yielded' as const, attempt: event.data.attempt }
 }
}

/** ID retained. New capped requests bypass this shared queue; old queued
 * requests are routed without HTTP, while genuine offers remain unpaced. */
export const drovrContactSyncRetry = inngest.createFunction(
 { id: 'drovr-contact-sync-retry-v1', name: 'drovr: route legacy retries and repair live offers', retries: DROVR_SEND_RETRIES, concurrency: [{ limit: 4 }], onFailure: async ({ event, error }) => captureFailedContactSyncRetry(event.data.event.data, error) },
 { event: CONTACT_SYNC_RETRY_EVENT },
 async ({ event, step, runId, attempt, maxAttempts }) => {
  if (isUncappedOfferRetry(event.data)) return runPacedContactSyncRetry({ event, step, runId, attempt, maxAttempts })
  const at = await step.run('route-clock', async () => Date.now())
  await step.sendEvent('route-capped-retry', routeContactSyncRetry({ ...event, name: CONTACT_SYNC_RETRY_EVENT, id: `legacy-retry:${event.id ?? runId}`, ts: at }))
  return { status: 'routed' as const, paceClass: retryPaceClass(event.data) }
 },
)
