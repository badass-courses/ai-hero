import { describe, expect, it, vi } from 'vitest'
import {
	proveRetryAcknowledgement,
	RETRY_PROOF_MAX_REFERENCES,
	retryProofRowsLive,
} from './contact-sync-retry-acknowledgement'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import type { RetryData } from './contact-sync-retry-route'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { supersededUnsubscribeReason } from './drovr-unsubscribe-supersession'

const load = vi.hoisted(() =>
	vi.fn(async (_target: string, _keys: readonly string[]) => []),
)
vi.mock('./contact-sync-held-batch-drizzle', () => ({
	heldBatchRowsLive: load,
}))
const clock = '2032-01-01T00:00:00.000Z'
const target = 'synthetic-ack-target'
const contactId = 'synthetic-ack-contact'
function stored(event: DrovrShadowEvent): DrovrOutboxRow {
	const entry = outboxEntryForEvent(event, 'bulkDelta')
	return {
		...entry,
		id: event.idempotencyKey,
		target,
		dedupeKey: drovrOutboxDedupeKey(target, entry),
		status: 'delivered',
		attempts: 1,
		lastStatus: 202,
		lastError: null,
		firstFailedAt: clock,
		nextAttemptAt: clock,
		lastAttemptAt: clock,
		deliveredAt: clock,
		releasedAt: null,
		createdAt: clock,
	}
}
function fixture() {
	const profile = stored({
		tenantId: 'org-aihero',
		contactId,
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		occurredAt: clock,
		idempotencyKey: `profile:${contactId}:3`,
		payload: {
			profileVersion: 3,
			email: 'learner@example.test',
			firstName: null,
			holds: [],
		},
	})
	const links = stored({
		tenantId: 'org-aihero',
		contactId,
		journeyId: 'contact-directory',
		type: 'contact.links.issued',
		occurredAt: clock,
		idempotencyKey: 'synthetic-links:3',
		payload: {
			profileVersion: 3,
			journeyId: 'crash-course-evergreen-offer',
			emailKey: 'synthetic-email',
			issuedAt: clock,
			expiresAt: '2032-05-01T00:00:00.000Z',
			variables: {},
			sendTimeFields: [],
		},
	})
	const data: RetryData = {
		items: [
			{ event: links.body as DrovrShadowEvent, reason: 'event-not-live' },
		],
		attempt: 1,
		firstFailedAt: clock,
		acknowledge: { contactId, profileVersion: 3 },
		paceClass: 'delta',
		deliverySource: 'contact-profile-sync',
		ownedKeys: [profile.dedupeKey, links.dedupeKey],
	}
	const all = [profile, links]
	const rows = vi.fn(async (_target: string, keys: readonly string[]) =>
		all.filter((row) => keys.includes(row.dedupeKey)),
	)
	return {
		profile,
		links,
		data,
		all,
		rows,
		args: { data, target, phase: 'terminal' as const, rows },
	}
}

describe('fresh whole-logical-batch acknowledgement proof', () => {
	it('proves the actual profile version and every frozen member, not just the last accepted link', async () => {
		const { args } = fixture()
		await expect(proveRetryAcknowledgement(args)).resolves.toEqual({
			proved: true,
			rejected: 0,
		})
	})
	it('stored version 3 can never acknowledge incoming version 4', async () => {
		const { args, data } = fixture()
		data.acknowledge!.profileVersion = 4
		await expect(proveRetryAcknowledgement(args)).resolves.toMatchObject({
			proved: false,
			reason: expect.stringContaining('first stored authority contact/version'),
		})
	})
	it.each(['pending', 'deferred', 'held'] as const)(
		'an earlier slice still %s prevents ACK even if the current link is delivered',
		async (status) => {
			const { args, profile } = fixture()
			profile.status = status
			await expect(proveRetryAcknowledgement(args)).resolves.toMatchObject({
				proved: false,
			})
		},
	)
	it('a retained rejection completes logically but is reported for ACK suppression, never new HTTP rejection', async () => {
		const { args, profile } = fixture()
		profile.status = 'rejected'
		profile.lastStatus = 409
		profile.deliveredAt = null
		await expect(proveRetryAcknowledgement(args)).resolves.toEqual({
			proved: true,
			rejected: 1,
		})
	})
	it('admission can allow the profile still in frozen membership, but never its held/rejected parent', async () => {
		const { args, profile } = fixture()
		profile.status = 'pending'
		await expect(
			proveRetryAcknowledgement({ ...args, phase: 'admission' }),
		).resolves.toMatchObject({ proved: true })
		profile.status = 'rejected'
		await expect(
			proveRetryAcknowledgement({ ...args, phase: 'admission' }),
		).resolves.toMatchObject({ proved: false })
	})
	it('legacy link-only retries require the exact omitted profile receipt and return its pin reference', async () => {
		const { args, data, profile, links } = fixture()
		data.ownedKeys = [links.dedupeKey]
		await expect(proveRetryAcknowledgement(args)).resolves.toEqual({
			proved: true,
			rejected: 0,
			additionalAuthority: profile.dedupeKey,
		})
	})
	it('an accepted offer/link cannot stand in for an unacknowledged or missing profile', async () => {
		const { args, data, profile, links, all } = fixture()
		data.ownedKeys = [links.dedupeKey]
		profile.status = 'pending'
		await expect(proveRetryAcknowledgement(args)).resolves.toMatchObject({
			proved: false,
		})
		all.splice(0, 1)
		await expect(proveRetryAcknowledgement(args)).resolves.toMatchObject({
			proved: false,
		})
	})
	it('holds malformed scope/body identity and missing/duplicated ownership membership', async () => {
		const { args, profile, data } = fixture()
		profile.contactId = 'synthetic-other-contact'
		await expect(proveRetryAcknowledgement(args)).resolves.toMatchObject({
			proved: false,
		})
		data.ownedKeys = []
		await expect(proveRetryAcknowledgement(args)).resolves.toMatchObject({
			proved: false,
		})
	})
	it('a valid strictly newer U0 closure may finish; ties and bounced/complained pseudo-closures cannot', async () => {
		for (const type of [
			'contact.unsubscribed',
			'contact.bounced',
			'contact.complained',
		] as const) {
			const { args, all, data } = fixture()
			const stop = stored({
				tenantId: 'org-aihero',
				contactId,
				journeyId: 'contact-directory',
				type,
				occurredAt: clock,
				idempotencyKey: `synthetic-stop:${type}`,
			})
			stop.status = 'superseded'
			stop.lastError = 'synthetic display-only note'
			const { buildUnsubscribeSupersession } =
				await import('./drovr-unsubscribe-supersession-proof')
			const proof =
				type === 'contact.unsubscribed'
					? buildUnsubscribeSupersession(
							stop,
							'2032-01-01T00:00:01.000Z',
							'2032-01-01T00:00:02.000Z',
						)
					: undefined
			stop.heldContinuation = {
				v: 1,
				...(proof ? { unsubscribeSupersession: proof } : {}),
			}
			all.push(stop)
			data.ownedKeys!.push(stop.dedupeKey)
			expect((await proveRetryAcknowledgement(args)).proved).toBe(
				type === 'contact.unsubscribed',
			)
			stop.lastError = supersededUnsubscribeReason(clock)
			expect((await proveRetryAcknowledgement(args)).proved).toBe(
				type === 'contact.unsubscribed',
			)
			if (proof)
				stop.heldContinuation = {
					v: 1,
					unsubscribeSupersession: {
						...proof,
						source: { ...proof.source, occurredAt: clock },
					},
				}
			expect((await proveRetryAcknowledgement(args)).proved).toBe(false)
		}
	})
	it('genuine offer/native batches without ACK still require all earlier frozen members terminal', async () => {
		const { args, data, profile } = fixture()
		data.acknowledge = undefined
		await expect(proveRetryAcknowledgement(args)).resolves.toEqual({
			proved: true,
			rejected: 0,
		})
		profile.status = 'pending'
		await expect(proveRetryAcknowledgement(args)).resolves.toMatchObject({
			proved: false,
		})
	})
	it('legacy proof reads are bounded chunks and overflow never truncates', async () => {
		load.mockClear()
		await retryProofRowsLive(
			target,
			Array.from({ length: RETRY_PROOF_MAX_REFERENCES }, (_, n) =>
				n.toString(16).padStart(64, '0'),
			),
		)
		expect(load).toHaveBeenCalledTimes(8)
		for (const call of load.mock.calls) expect(call[1]).toHaveLength(128)
		load.mockClear()
		await expect(
			retryProofRowsLive(
				target,
				Array(RETRY_PROOF_MAX_REFERENCES + 1).fill('a'.repeat(64)),
			),
		).rejects.toThrow(/bounded legacy reference budget/)
		expect(load).not.toHaveBeenCalled()
	})
})
