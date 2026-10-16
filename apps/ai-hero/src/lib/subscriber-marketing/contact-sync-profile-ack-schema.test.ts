import { Either, Schema } from 'effect'
import { expect, it } from 'vitest'
import {
	AckEvidenceExpired,
	PROFILE_ACK_MAX_REFERENCES,
	ProfileAck,
	type ProfileAckReference,
} from './contact-sync-profile-ack-schema'
import { RETRY_PROOF_MAX_REFERENCES } from './contact-sync-retry-acknowledgement'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	OUTBOX_CONTROL_MAX_ENCODED_BYTES,
} from './drovr-outbox-control'

const at = '2032-01-01T00:00:00.000Z'
const ref: ProfileAckReference = {
	target: 'synthetic-target',
	endpoint: 'events',
	tenantId: 'org-aihero',
	contactId: 'synthetic-contact',
	journeyId: 'contact-directory',
	profileVersion: 3,
	coordinatorKey: 'a'.repeat(64),
	requestId: 'd'.repeat(64),
	request: { kind: 'delta' },
}
const coordinator = () => ({
	v: 1 as const,
	role: 'coordinator' as const,
	ref,
	registeredAt: at,
	members: [
		{
			key: 'a'.repeat(64),
			eventType: 'contact.profile.updated' as const,
			bodyHash: 'c'.repeat(64),
			firstFailedAt: at,
		},
		{
			key: 'b'.repeat(64),
			eventType: 'contact.links.issued' as const,
			bodyHash: 'c'.repeat(64),
			firstFailedAt: at,
		},
	],
})
it('has an independently versioned fifth member, not an overloaded replay proof', () => {
	const profileAck = coordinator()
	const value = { v: 1, replayProof: { v: 1, handoffs: 7 }, profileAck }
	expect(
		readHeldContinuationEnvelope(encodeHeldContinuationEnvelope(value)),
	).toEqual(value)
	expect(PROFILE_ACK_MAX_REFERENCES).toBe(RETRY_PROOF_MAX_REFERENCES)
	expect(OUTBOX_CONTROL_MAX_ENCODED_BYTES).toBe(256 * 1024)
	expect(() =>
		encodeHeldContinuationEnvelope({
			v: 1,
			replayProof: { v: 1, handoffs: 7, profileAck },
		}),
	).toThrow(/OutboxControl:/)
})
it('preserves the other four independently tagged members while encoding profile ACK state', () => {
	const scope = {
		key: 'a'.repeat(64),
		target: 'synthetic-target',
		endpoint: 'events',
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'value-path-skills-course',
		eventType: 'contact.unsubscribed',
		idempotencyKey: 'owner:synthetic:unsubscribe',
		occurredAt: at,
	}
	const value = {
		v: 1,
		continuation: { v: 1, blocked: true, reason: 'synthetic operator hold' },
		replayProof: { v: 1, handoffs: 1 },
		ownerStopRejection: {
			v: 1,
			scope,
			rejectionCode: 'cold-start-never-born',
			httpStatus: 409,
			rejectedAttempt: {
				runId: 'synthetic-run',
				requestId: '00000000-0000-4000-8000-000000000001',
				stepKey: scope.key,
				attempt: 0,
			},
			decidedAt: at,
		},
		unsubscribeSupersession: {
			v: 1,
			scope,
			source: {
				table: 'AI_ContactEvent',
				eventType: 'contact.resubscribed',
				contactId: scope.contactId,
				occurredAt: '2032-01-01T00:00:01.000Z',
			},
			decidedAt: '2032-01-01T00:00:02.000Z',
		},
		profileAck: coordinator(),
	}
	expect(
		readHeldContinuationEnvelope(encodeHeldContinuationEnvelope(value)),
	).toEqual(value)
})
it('keeps participant metadata to a scoped coordinator reference, without bodies or inferred proof', () => {
	const value = { v: 1, role: 'member', ref }
	expect(Schema.decodeUnknownSync(ProfileAck)(value)).toEqual(value)
	expect(() =>
		encodeHeldContinuationEnvelope({
			v: 1,
			profileAck: { ...value, body: { email: 'synthetic@example.test' } },
		}),
	).toThrow()
})
it.each([
	(c: ReturnType<typeof coordinator>) => ({ ...c, v: 2 }),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		ref: { ...ref, profileVersion: 0 },
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		ref: { ...ref, profileVersion: 1.5 },
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		ref: { ...ref, profileVersion: Number.MAX_SAFE_INTEGER + 1 },
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		ref: { ...ref, coordinatorKey: 'b'.repeat(64) },
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		ref: { ...ref, target: '' },
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		ref: { ...ref, request: { kind: 'delta', period: '2032-01' } },
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		ref: { ...ref, request: { kind: 'restate', period: '2032-13' } },
	}),
	(c: ReturnType<typeof coordinator>) => ({ ...c, members: [] }),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		members: [c.members[0], c.members[0]],
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		members: [...c.members].reverse(),
	}),
	(c: ReturnType<typeof coordinator>) => ({ ...c, members: [c.members[1]] }),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		members: c.members.map((member) => ({
			...member,
			eventType: 'contact.profile.updated',
		})),
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		registeredAt: '2032-02-30T00:00:00.000Z',
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		completion: {
			proofId: 'f'.repeat(64),
			confirmationClock: at,
			provedAt: 'tomorrow',
			disposition: 'acknowledged',
		},
	}),
	(c: ReturnType<typeof coordinator>) => ({
		...c,
		completion: {
			proofId: 'f'.repeat(64),
			confirmationClock: at,
			provedAt: at,
			disposition: 'delivered-without-proof',
		},
	}),
])(
	'refuses malformed, ambiguous or partial ACK authority without normalization',
	(mutate) => {
		const value = mutate(coordinator())
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(ProfileAck, { onExcessProperty: 'error' })(
					value,
				),
			),
		).toBe(true)
		expect(() =>
			encodeHeldContinuationEnvelope({ v: 1, profileAck: value }),
		).toThrow(/OutboxControl:/)
	},
)
it('accepts explicit monthly request identity separately from the original delta', () => {
	for (const period of ['2032-01', '2032-02']) {
		const value = {
			...coordinator(),
			ref: { ...ref, request: { kind: 'restate', period } },
			completion: {
				proofId: 'f'.repeat(64),
				confirmationClock: at,
				provedAt: at,
				disposition: 'acknowledged',
			},
		}
		expect(
			readHeldContinuationEnvelope(
				encodeHeldContinuationEnvelope({ v: 1, profileAck: value }),
			)?.profileAck,
		).toEqual(value)
	}
})
it('bounds references without truncation', () => {
	const value = coordinator()
	value.ref = { ...ref, coordinatorKey: '0'.repeat(64) }
	value.members = Array.from(
		{ length: PROFILE_ACK_MAX_REFERENCES + 1 },
		(_, index) => ({
			...value.members[1]!,
			key: index.toString(16).padStart(64, '0'),
			eventType:
				index === 0
					? ('contact.profile.updated' as const)
					: ('contact.links.issued' as const),
		}),
	)
	expect(() =>
		encodeHeldContinuationEnvelope({ v: 1, profileAck: value }),
	).toThrow()
	value.members.pop()
	expect(() =>
		encodeHeldContinuationEnvelope({ v: 1, profileAck: value }),
	).not.toThrow()
})
it('constructs AckEvidenceExpired as a typed terminal value, not a retried exception', () => {
	const result = AckEvidenceExpired.make({
		v: 1,
		target: ref.target,
		contactId: ref.contactId,
		profileVersion: ref.profileVersion,
		requestId: ref.requestId,
	})
	expect(result._tag).toBe('AckEvidenceExpired')
	expect(result).not.toBeInstanceOf(Error)
	expect(
		Schema.decodeUnknownSync(AckEvidenceExpired)(
			JSON.parse(JSON.stringify(result)),
		),
	).toEqual(result)
})
