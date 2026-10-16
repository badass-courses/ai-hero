import { expect, it, vi } from 'vitest'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import {
	runContactProfileSync,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import {
	freezeProfileAckRequest,
	expiredProfileAck,
} from './contact-sync-profile-ack'
import { guardProfileAckWorkerAdmission } from './contact-sync-profile-ack-admission'
import type {
	ProfileAckProducerPorts,
	ProfileAckPreparation,
} from './contact-sync-profile-ack-registration'
import {
	readHeldContinuationEnvelope,
	encodeHeldContinuationEnvelope,
} from './drovr-outbox-control'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'

const first = '2032-01-01T00:00:00.000Z'
const delivered = '2032-03-20T00:00:00.000Z'
function model(
	options: {
		accept?: boolean
		failCommit?: boolean
		enabled?: boolean
		missingPort?: boolean
	} = {},
) {
	const contactId = 'synthetic-ack-producer-model',
		target = 'synthetic-producer-target'
	const rows = new Map<string, DrovrOutboxRow>(),
		cache = new Map<string, unknown>()
	let enabled = options.enabled ?? true,
		clock = first,
		failCommit = options.failCommit ?? false
	let current: ContactProfileSnapshot = {
		occurredAt: first,
		profile: { email: 'synthetic@example.test', firstName: null, holds: [] },
		links: [
			{
				journeyId: 'value-path-skills-course',
				emailKey: 'synthetic-email',
				issuedAt: first,
				expiresAt: '2032-05-01T00:00:00.000Z',
				variables: {},
				sendTimeFields: [],
			},
		],
		offers: [],
	}
	const readRows = async (keys: readonly string[]) =>
		keys.flatMap((key) => (rows.has(key) ? [rows.get(key)!] : []))
	const store = createMemoryContactProfileVersionStore({
		now: () => clock,
		includeRegistrationCapability: true,
		profileAckEnabled: async () => enabled,
		hasRegisteredProfileAck: (id, v) =>
			[...rows.values()].some((row) => {
				const state = readHeldContinuationEnvelope(
					row.heldContinuation,
				)?.profileAck
				return state?.ref.contactId === id && state.ref.profileVersion === v
			}),
		beforeProfileAckCommit: () => {
			if (failCommit) {
				failCommit = false
				throw new Error('synthetic memory ACK write failure')
			}
		},
	})
	const step = {
		run: async <T>(id: string, callback: () => Promise<T>) => {
			if (cache.has(id)) return structuredClone(cache.get(id))
			const value = await callback()
			cache.set(id, structuredClone(value))
			return structuredClone(value)
		},
		sendEvent: vi.fn(async () => undefined),
	}
	const legacyDeliver = vi.fn(async () => ({ accepted: 999, rejected: 0 })),
		legacyAck = vi.fn(store.acknowledge),
		legacyWriter = vi.fn(store.acknowledgeLegacy),
		booleanProof = vi.fn(async () => true),
		birth = vi.fn(async () => undefined)
	const prepare = vi.fn(
		async (
			input: Parameters<ProfileAckProducerPorts['prepare']>[0],
		): Promise<ProfileAckPreparation> => {
			for (const row of rows.values()) {
				const state = readHeldContinuationEnvelope(
					row.heldContinuation,
				)?.profileAck
				if (state) return { _tag: 'ProfileAckKnown', ref: state.ref }
			}
			if (!enabled) return { _tag: 'ProfileAckDisabled' }
			const logical = {
				target,
				contactId,
				profileVersion: input.version.profileVersion,
				request: input.request,
			}
			if (input.version.profileAckProtocol !== 1 || !input.version.newlyIssued)
				return {
					_tag: 'ProfileAckUnavailable',
					logical,
					reason: 'legacy-sdk-unregistered',
				}
			const staged: DrovrOutboxRow[] = input.events.map((event) => {
				const entry = outboxEntryForEvent(event, 'bulkDelta'),
					key = drovrOutboxDedupeKey(target, entry)
				return {
					...entry,
					id: key,
					dedupeKey: key,
					target,
					status: 'pending',
					attempts: 0,
					lastStatus: null,
					lastError: 'not authority',
					firstFailedAt: first,
					nextAttemptAt: '2032-01-02T00:00:00.000Z',
					lastAttemptAt: null,
					deliveredAt: null,
					releasedAt: null,
					createdAt: first,
				}
			})
			const state = freezeProfileAckRequest({
				target,
				contactId,
				profileVersion: input.version.profileVersion,
				registeredAt: first,
				rows: staged,
			})
			for (const row of staged) {
				row.heldContinuation = encodeHeldContinuationEnvelope({
					v: 1,
					profileAck:
						row.dedupeKey === state.ref.coordinatorKey
							? state
							: { v: 1, role: 'member', ref: state.ref },
				})
				rows.set(row.dedupeKey, row)
			}
			return { _tag: 'ProfileAckCaptured', ref: state.ref }
		},
	)
	const admit = vi.fn(
		async (ref: Parameters<ProfileAckProducerPorts['admit']>[0]) =>
			guardProfileAckWorkerAdmission({
				database: undefined,
				target,
				ref,
				events: [],
				ackOnly: true,
				readRows: async (_db, _target, keys) =>
					(await readRows(keys)).map((row) => ({
						...row,
						heldContinuation: row.heldContinuation ?? null,
					})),
			}),
	)
	const publish = vi.fn(
		async (ref: Parameters<ProfileAckProducerPorts['publish']>[0]) => {
			const denied = await guardProfileAckWorkerAdmission({
				database: undefined,
				target,
				ref,
				events: [],
				ackOnly: true,
				readRows: async (_db, _target, keys) =>
					(await readRows(keys)).map((row) => ({
						...row,
						heldContinuation: row.heldContinuation ?? null,
					})),
			})
			if (denied) return denied
			if (options.accept !== false)
				for (const row of rows.values()) {
					row.status = 'delivered'
					row.lastStatus = 202
					row.deliveredAt = delivered
					row.lastAttemptAt = delivered
				}
			return { _tag: 'ProfileAckPublished' as const }
		},
	)
	const complete = vi.fn(
		async (ref: Parameters<ProfileAckProducerPorts['complete']>[0]) => {
			const result = await store.acknowledgeFrozen({ ref, readRows })
			if (result._tag === 'ProfileAckDisabled')
				return { _tag: 'ProfileAckAwaitingProof' as const }
			if (result.evaluation._tag === 'AckEvidenceExpired')
				return result.evaluation
			if (result.evaluation._tag === 'ProfileAckReceiverRefused')
				return { _tag: 'ProfileAckReceiverRefused' as const }
			if (result.evaluation._tag !== 'ProfileAckReady')
				return { _tag: 'ProfileAckAwaitingProof' as const }
			return {
				_tag: 'ProfileAckConfirmed' as const,
				ref,
				links: result.confirmedLinks!,
				confirmationClock: result.evaluation.proof.confirmationClock,
				disposition: result.disposition!,
			}
		},
	)
	const epoch = vi.fn(async () => first)
	const run = () =>
		runContactProfileSync({
			event: { data: { contactId, reason: 'reconcile' } },
			step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			readSnapshot: async () => current,
			versionFor: store.versionFor,
			currentVersion: store.currentFor,
			deliver: legacyDeliver,
			acknowledge: legacyAck,
			acknowledgeLegacy: legacyWriter,
			proveDelivery: booleanProof,
			profileAckEnabled: async () => enabled,
			profileAck: options.missingPort
				? undefined
				: { registrationEpoch: epoch, prepare, admit, publish, complete },
			ownedPath: async () => undefined,
			onSendingJourney: async () => true,
			birth,
		})
	return {
		run,
		rows,
		cache,
		store,
		prepare,
		admit,
		publish,
		complete,
		epoch,
		legacyAck,
		legacyWriter,
		legacyDeliver,
		booleanProof,
		birth,
		setEnabled: (value: boolean) => {
			enabled = value
		},
		setClock: (value: string) => {
			clock = value
		},
		mutateSnapshot: () => {
			current = {
				...current,
				profile: { ...current.profile, email: 'changed@example.test' },
			}
		},
		contactId,
	}
}
it('root captures a frozen SDK reference before publication and ACKs only inside the actual fresh effect', async () => {
	const m = model()
	expect(await m.run()).toMatchObject({
		status: 'sent',
		profileVersion: 1,
		links: 1,
		accepted: 0,
	})
	expect(m.prepare).toHaveBeenCalledTimes(1)
	expect(m.publish).toHaveBeenCalledTimes(1)
	expect(m.complete).toHaveBeenCalledTimes(1)
	expect(m.cache.has('delta-registration-epoch')).toBe(true)
	expect(
		[...m.cache.keys()].findIndex((key) => key === 'delta-prepare-frozen-ack'),
	).toBeLessThan(
		[...m.cache.keys()].findIndex((key) => key === 'delta-deliver-profile'),
	)
	expect(await m.store.currentFor(m.contactId)).toMatchObject({
		acknowledged: true,
		acknowledgedAt: first,
	})
	for (const spy of [
		m.legacyAck,
		m.legacyWriter,
		m.legacyDeliver,
		m.booleanProof,
		m.birth,
	])
		expect(spy).not.toHaveBeenCalled()
})
it('a completed cached SDK result cannot resurrect purged membership or refresh its frozen age', async () => {
	const m = model()
	expect(await m.run()).toMatchObject({ status: 'sent' })
	m.setClock(delivered)
	expect(await m.run()).toMatchObject({ status: 'sent' })
	expect(await m.store.currentFor(m.contactId)).toMatchObject({
		acknowledgedAt: first,
	})
	m.rows.clear()
	expect(await m.run()).toMatchObject({ status: 'ack-evidence-expired' })
	expect(m.publish).toHaveBeenCalledTimes(1)
	expect(m.complete).toHaveBeenCalledTimes(1)
})
it('cached successful confirmation is still fenced by changed retained first bytes', async () => {
	const m = model()
	await m.run()
	const row = [...m.rows.values()].find(
		(row) => row.eventType === 'contact.profile.updated',
	)!
	row.body = { ...row.body, contactId: 'synthetic-foreign-contact' }
	await expect(m.run()).rejects.toThrow('ProfileAckConflict:')
	expect(m.complete).toHaveBeenCalledTimes(1)
})
it('memory frozen completion refuses an older proof instead of moving a newer confirmation clock backward', async () => {
	const m = model({ failCommit: true })
	await expect(m.run()).rejects.toThrow('synthetic memory ACK write failure')
	const retained = [...m.rows.entries()]
	m.rows.clear()
	m.setEnabled(false)
	m.setClock(delivered)
	await m.store.acknowledge(m.contactId, 1)
	for (const [key, row] of retained) m.rows.set(key, row)
	m.setEnabled(true)
	await expect(m.run()).rejects.toThrow(
		'CONFIRMATION CLOCK WOULD MOVE BACKWARD',
	)
	expect(await m.store.currentFor(m.contactId)).toMatchObject({
		acknowledgedAt: delivered,
	})
	expect(
		[...m.rows.values()].some(
			(row) =>
				readHeldContinuationEnvelope(row.heldContinuation)?.profileAck?.role ===
					'coordinator' &&
				'completion' in
					readHeldContinuationEnvelope(row.heldContinuation)!.profileAck!,
		),
	).toBe(false)
})
it('a queue handoff with zero delivered original members remains awaiting proof', async () => {
	const m = model({ accept: false })
	expect(await m.run()).toMatchObject({ status: 'awaiting-proof' })
	expect(await m.store.currentFor(m.contactId)).toMatchObject({
		acknowledged: false,
	})
	expect(m.legacyWriter).not.toHaveBeenCalled()
})
it('positive boolean/counters cannot replace the missing atomic registration adapter', async () => {
	const m = model({ missingPort: true })
	expect(await m.run()).toMatchObject({
		status: 'ack-unavailable',
		reason: 'registration-adapter-unavailable',
	})
	for (const spy of [
		m.legacyAck,
		m.legacyWriter,
		m.legacyDeliver,
		m.booleanProof,
		m.publish,
	])
		expect(spy).not.toHaveBeenCalled()
	expect(m.rows.size).toBe(0)
})
it('a failed ACK write cannot reuse its positive proof after an intervening hold or current-snapshot mutation', async () => {
	const m = model({ failCommit: true })
	await expect(m.run()).rejects.toThrow('synthetic memory ACK write failure')
	const original = JSON.stringify([...m.rows.values()].map((row) => row.body))
	const link = [...m.rows.values()].find(
		(row) => row.eventType === 'contact.links.issued',
	)!
	link.status = 'held'
	m.setClock(delivered)
	m.mutateSnapshot()
	expect(await m.run()).toMatchObject({ status: 'awaiting-proof' })
	expect(m.publish).toHaveBeenCalledTimes(1)
	expect(m.prepare).toHaveBeenCalledTimes(1)
	expect(m.complete).toHaveBeenCalledTimes(2)
	expect(await m.store.currentFor(m.contactId)).toMatchObject({
		acknowledged: false,
	})
	expect(JSON.stringify([...m.rows.values()].map((row) => row.body))).toBe(
		original,
	)
})
it('an original SDK whose retained evidence disappeared terminates without recapture or another publication', async () => {
	const m = model({ failCommit: true })
	await expect(m.run()).rejects.toThrow('synthetic memory ACK write failure')
	const ref = (
		m.cache.get('delta-prepare-frozen-ack') as Extract<
			ProfileAckPreparation,
			{ _tag: 'ProfileAckCaptured' }
		>
	).ref
	m.rows.clear()
	m.setClock(delivered)
	m.mutateSnapshot()
	expect(await m.run()).toEqual({
		status: 'ack-evidence-expired',
		profileVersion: 1,
		evidence: expiredProfileAck(ref),
	})
	expect(m.publish).toHaveBeenCalledTimes(1)
	expect(m.prepare).toHaveBeenCalledTimes(1)
	for (const spy of [
		m.legacyAck,
		m.legacyWriter,
		m.legacyDeliver,
		m.booleanProof,
	])
		expect(spy).not.toHaveBeenCalled()
})
it('a known stored request is completion-only even OFF, without a new native capture/publication or NOW fallback', async () => {
	const m = model({ accept: false })
	await m.run()
	m.cache.clear()
	m.setEnabled(false)
	m.setClock(delivered)
	const before = JSON.stringify([...m.rows.values()])
	expect(await m.run()).toMatchObject({ status: 'awaiting-proof' })
	expect(m.publish).toHaveBeenCalledTimes(1)
	expect(JSON.stringify([...m.rows.values()])).toBe(before)
	for (const spy of [m.legacyAck, m.legacyWriter, m.legacyDeliver])
		expect(spy).not.toHaveBeenCalled()
})
it('a memoized OFF preparation cannot turn ON after legacy publication or reuse an optimistic legacy ACK', async () => {
	const m = model({ enabled: false })
	expect(await m.run()).toMatchObject({ status: 'sent' })
	m.setEnabled(true)
	expect(await m.run()).toMatchObject({
		status: 'ack-unavailable',
		reason: 'registration-disabled-before-publication',
	})
	expect(m.legacyDeliver).toHaveBeenCalledTimes(1)
	expect(m.legacyWriter).toHaveBeenCalledTimes(1)
	expect(m.rows.size).toBe(0)
})
