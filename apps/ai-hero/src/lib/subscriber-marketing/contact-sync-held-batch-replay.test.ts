import { describe, expect, it, vi } from 'vitest'
import {
	encodeHeldBatchContinuation,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'
import {
	prepareHeldBatchReplay,
	type HeldBatchReplayPorts,
} from './contact-sync-held-batch-replay'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

import { supersededUnsubscribeReason } from './drovr-unsubscribe-supersession'

const clock = '2032-01-01T00:00:00.000Z'
const releaseId = '00000000-0000-4000-8000-000000000001'
const target = 'synthetic-replay-target'
function fixture() {
	const base = {
		tenantId: 'org-aihero' as const,
		contactId: 'synthetic-replay-contact',
		journeyId: 'contact-directory' as const,
		occurredAt: clock,
	}
	const events: DrovrShadowEvent[] = [
		{
			...base,
			type: 'contact.profile.updated',
			idempotencyKey: 'synthetic-profile:3',
			payload: {
				profileVersion: 3,
				email: 'learner@example.test',
				firstName: null,
				holds: [],
			},
		},
		{
			...base,
			type: 'contact.links.issued',
			idempotencyKey: 'synthetic-links:3',
			payload: {
				profileVersion: 3,
				journeyId: 'value-path-skills-course',
				emailKey: 'email',
				issuedAt: clock,
				expiresAt: '2032-05-01T00:00:00.000Z',
				variables: {},
				sendTimeFields: [],
			},
		},
		{
			...base,
			type: 'contact.offer.issued',
			idempotencyKey: 'synthetic-offer:3',
			payload: {
				profileVersion: 3,
				journeyId: 'crash-course-evergreen-offer',
				variables: {},
			},
		},
	]
	const rows: DrovrOutboxRow[] = events.map((event, index) => {
		const entry = outboxEntryForEvent(event, 'bulkDelta')
		return {
			...entry,
			target,
			id: `synthetic-row-${index}`,
			dedupeKey: drovrOutboxDedupeKey(target, entry),
			status: index === 2 ? 'delivered' : 'pending',
			attempts: 0,
			lastStatus: null,
			lastError: null,
			firstFailedAt: clock,
			nextAttemptAt: clock,
			lastAttemptAt: null,
			deliveredAt: index === 2 ? clock : null,
			releasedAt: null,
			createdAt: clock,
		}
	})
	const root: HeldBatchContinuation = {
		v: 1,
		release: { state: 'released', id: releaseId },
		target,
		anchorKey: rows[0]!.dedupeKey,
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: clock,
		parkedAt: clock,
		completion: { state: 'unfinished' },
		attempt: 2,
		rejectedCarry: 0,
		acknowledge: { contactId: base.contactId, profileVersion: 3 },
		members: [
			{ key: rows[0]!.dedupeKey, phase: 'pending', reason: 'event-not-live' },
			{
				key: rows[1]!.dedupeKey,
				phase: 'carry',
				reason: 'cold-start-unhandled',
			},
			{ key: rows[2]!.dedupeKey, phase: 'retained' },
		],
	}
	const anchor = rows[0]!
	anchor.heldBatch = encodeHeldBatchContinuation(root)
	const ports: HeldBatchReplayPorts = {
		rows: vi.fn(async () => rows),
		block: vi.fn(async (_scope, _reason, expected) => {
			if (anchor.heldBatch !== expected.encoded) return false
			anchor.heldBatchBlocked = true
			if (anchor.status === 'pending') anchor.status = 'held'
			return true
		}),
	}
	return { root, rows, anchor, ports }
}

describe('strict held-batch reconstruction', () => {
	it('ignores ordinary outbox rows without loading or publishing any continuation', async () => {
		const { anchor, ports } = fixture()
		delete anchor.heldBatch
		expect(await prepareHeldBatchReplay(anchor, ports)).toBeUndefined()
		expect(ports.rows).not.toHaveBeenCalled()
		expect(ports.block).not.toHaveBeenCalled()
	})
	it('never automatically requeues a held anchor, even with structurally valid references', async () => {
		const { root, anchor, ports } = fixture()
		anchor.heldBatch = encodeHeldBatchContinuation({
			...root,
			release: { state: 'held' },
		})
		expect(await prepareHeldBatchReplay(anchor, ports)).toMatchObject({
			kind: 'held',
		})
		expect(ports.rows).not.toHaveBeenCalled()
		expect(anchor.heldBatchBlocked).toBe(true)
		expect(anchor.status).toBe('held')
	})
	it.each(['{', JSON.stringify({ v: 2 }), 123, undefined])(
		'decode failure leaves the unchanged anchor held, never a request: %j',
		async (raw) => {
			const { anchor, ports } = fixture()
			anchor.heldBatch = raw
			await expect(prepareHeldBatchReplay(anchor, ports)).rejects.toThrow(
				/HeldBatchContinuation:/,
			)
			expect(anchor.heldBatch).toBe(raw)
			expect(anchor.status).toBe('held')
			expect(anchor.heldBatchBlocked).toBe(true)
			expect(ports.rows).not.toHaveBeenCalled()
		},
	)
	it('reconstructs only first stored bodies, full scoped membership and original clocks after explicit release', async () => {
		const { root, rows, anchor, ports } = fixture()
		rows[1]!.firstFailedAt = '2031-12-31T23:00:00.000Z'
		const before = JSON.stringify(rows)
		const plan = await prepareHeldBatchReplay(anchor, ports)
		expect(plan).toMatchObject({
			kind: 'retry',
			request: {
				id: `held-batch:${root.anchorKey}:${releaseId}`,
				data: {
					items: [{ event: rows[0]!.body, reason: 'event-not-live' }],
					carry: [{ event: rows[1]!.body, reason: 'cold-start-unhandled' }],
					firstFailedAt: clock,
					ownedKeys: root.members.map((ref) => ref.key),
					acknowledge: root.acknowledge,
					deliverySource: root.source,
					paceClass: root.class,
					heldBatchRelease: { anchorKey: root.anchorKey, id: releaseId },
				},
			},
		})
		expect(JSON.stringify(rows)).toBe(before)
		expect(ports.block).not.toHaveBeenCalled()
	})
	it.each([
		'missing',
		'duplicate',
		'scope',
		'body',
		'parent',
		'held',
		'prior-pending',
		'prior-rejection',
	] as const)(
		'fails closed on %s proof, not metadata acceptance',
		async (mode) => {
			const { rows, anchor, ports } = fixture()
			if (mode === 'missing') rows.pop()
			if (mode === 'duplicate') rows[2] = rows[1]!
			if (mode === 'scope') rows[1]!.target = 'another-synthetic-target'
			if (mode === 'body')
				rows[1]!.body = {
					...(rows[1]!.body as DrovrShadowEvent),
					contactId: 'another-synthetic-contact',
				}
			if (mode === 'parent') rows[1]!.needsFanOut = true
			if (mode === 'held') rows[1]!.status = 'held'
			if (mode === 'prior-pending') rows[2]!.status = 'pending'
			if (mode === 'prior-rejection') rows[2]!.status = 'rejected'
			await expect(prepareHeldBatchReplay(anchor, ports)).rejects.toThrow(
				/HeldBatchContinuation:/,
			)
			expect(anchor.status).toBe('held')
			expect(anchor.heldBatchBlocked).toBe(true)
		},
	)
	it('never acknowledges the incoming version instead of the first stored version', async () => {
		const { root, anchor, ports } = fixture()
		anchor.heldBatch = encodeHeldBatchContinuation({
			...root,
			acknowledge: { ...root.acknowledge!, profileVersion: 4 },
		})
		await expect(prepareHeldBatchReplay(anchor, ports)).rejects.toThrow(
			/first stored authority contact\/version/,
		)
		expect(anchor.status).toBe('held')
	})
	it('opaque live-class metadata cannot grant unpaced delivery to profile/link bodies', async () => {
		const { root, anchor, ports } = fixture()
		anchor.heldBatch = encodeHeldBatchContinuation({
			...root,
			source: 'live',
			class: 'live',
			acknowledge: undefined,
		})
		await expect(prepareHeldBatchReplay(anchor, ports)).rejects.toThrow(
			/live offer permission/,
		)
		expect(anchor.status).toBe('held')
	})
	it.each([
		{
			type: 'contact.unsubscribed',
			lift: '2032-01-01T00:00:01.000Z',
			valid: true,
		},
		{ type: 'contact.unsubscribed', lift: clock, valid: false },
		{ type: 'contact.bounced', lift: '2032-01-01T00:00:01.000Z', valid: false },
		{
			type: 'contact.complained',
			lift: '2032-01-01T00:00:01.000Z',
			valid: false,
		},
	] as const)(
		'retained closure requires strictly newer U0 proof, never a tie/B/C: $type $lift',
		async ({ type, lift, valid }) => {
			const { root, anchor, ports } = fixture()
			anchor.eventType = type
			anchor.body = {
				...(anchor.body as DrovrShadowEvent),
				type,
				payload: undefined,
			}
			anchor.status = 'superseded'
			anchor.lastError = supersededUnsubscribeReason(lift)
			anchor.heldBatch = encodeHeldBatchContinuation({
				...root,
				acknowledge: undefined,
				members: [
					{ key: anchor.dedupeKey, phase: 'pending', reason: 'event-not-live' },
				],
			})
			const { buildUnsubscribeSupersession } =
				await import('./drovr-unsubscribe-supersession-proof')
			const proof =
				type === 'contact.unsubscribed'
					? buildUnsubscribeSupersession(
							anchor,
							'2032-01-01T00:00:01.000Z',
							'2032-01-01T00:00:02.000Z',
						)
					: undefined
			anchor.heldContinuation = {
				v: 1,
				continuation: { v: 1, encoded: anchor.heldBatch, blocked: false },
				...(proof
					? {
							unsubscribeSupersession: {
								...proof,
								source: { ...proof.source, occurredAt: lift },
							},
						}
					: {}),
			}
			ports.rows = vi.fn(async () => [anchor])
			if (valid)
				expect(await prepareHeldBatchReplay(anchor, ports)).toMatchObject({
					kind: 'retry',
					request: { data: { items: [{ event: anchor.body }] } },
				})
			else
				await expect(prepareHeldBatchReplay(anchor, ports)).rejects.toThrow(
					/strictly newer source proof/,
				)
			expect(anchor.status).toBe('superseded')
		},
	)
	it('retains genuine-offer permission without introducing a bulk source or profile acknowledgement', async () => {
		const { root, rows, ports } = fixture()
		const offer = rows[2]!
		offer.status = 'pending'
		offer.heldBatch = encodeHeldBatchContinuation({
			...root,
			source: 'live',
			class: 'live',
			acknowledge: undefined,
			anchorKey: offer.dedupeKey,
			members: [
				{ key: offer.dedupeKey, phase: 'pending', reason: 'event-not-live' },
			],
		})
		ports.rows = vi.fn(async () => [offer])
		const plan = await prepareHeldBatchReplay(offer, ports)
		expect(plan?.kind).toBe('retry')
		if (plan?.kind !== 'retry') throw new Error('synthetic release missing')
		expect(plan.request.data).not.toHaveProperty('deliverySource')
		expect(plan.request.data).not.toHaveProperty('paceClass')
		expect(plan.request.data).not.toHaveProperty('acknowledge')
	})
	it('a stale invalid snapshot cannot revoke a newer release or claim a held receipt', async () => {
		const { anchor, ports } = fixture()
		anchor.heldBatch = '{'
		ports.block = vi.fn(async () => false)
		await expect(prepareHeldBatchReplay(anchor, ports)).rejects.toThrow(
			/newer state was not rewritten or acknowledged/,
		)
		expect(anchor.status).toBe('pending')
		expect(anchor.heldBatchBlocked).toBeUndefined()
	})
})
