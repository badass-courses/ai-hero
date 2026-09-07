import { describe, expect, it } from 'vitest'
import { ownerProofFixture } from './verified-owner-proof.fixtures'
import {
	createVerifiedOwnerProofReader,
	VerifiedOwnerProofUnavailable,
} from './verified-owner-proof'
import { sessionTokenHash } from './verified-owner-evidence'

type Fixture = ReturnType<typeof ownerProofFixture>
const run = (f: Fixture) =>
	createVerifiedOwnerProofReader({
		store: f.store,
		secret: f.secret,
		now: () => f.now,
	})(f.input)
const login = (f: Fixture) => f.rows[0]!.payloadSummary
const claim = (f: Fixture) => f.rows[1]!.payloadSummary

describe('exact dormant verified owner proof', () => {
	it('restores an identity-bound canonical bind origin and two linked event records with five exact reads', async () => {
		const f = ownerProofFixture()
		expect(await run(f)).toEqual({
			type: 'VerifiedUserObserved',
			contactId: f.input.contactId,
			journeyId: f.input.journeyId,
			verifiedUserId: f.input.verifiedUserId,
			observedAt: f.claim.observedAt,
			sourceReference: 'contact-event:proof-claim-event',
		})
		expect(f.calls).toEqual([
			`intent:${f.intentRow.idempotencyKey}`,
			'commit:proof-claim-event',
			'event:proof-claim-event',
			'event:proof-login-event',
			'identity:proof-kit-identity',
		])
	})
	const cases: [string, (f: Fixture) => void][] = [
		[
			'wrong journey',
			(f) => {
				f.input = { ...f.input, journeyId: 'other' }
			},
		],
		[
			'wrong contact',
			(f) => {
				f.input = { ...f.input, contactId: 'other' }
			},
		],
		[
			'wrong user',
			(f) => {
				f.input = { ...f.input, verifiedUserId: 'other' }
			},
		],
		[
			'wrong coupon',
			(f) => {
				f.input = { ...f.input, couponId: 'other' }
			},
		],
		[
			'wrong session / OAuth session',
			(f) => {
				claim(f).sessionTokenHash = sessionTokenHash(f.secret, 'oauth-session')
			},
		],
		[
			'foreign attestation',
			(f) => {
				claim(f).attestationEventId = 'missing-event'
			},
		],
		[
			'claim copies wrong verifiedAt',
			(f) => {
				claim(f).verifiedAt = '2026-09-10T16:00:00.124Z'
			},
		],
		[
			'claim copies wrong fingerprint',
			(f) => {
				claim(f).emailFingerprint = '0'.repeat(64)
			},
		],
		[
			'login wrong user',
			(f) => {
				login(f).userId = 'other'
			},
		],
		[
			'login wrong contact',
			(f) => {
				login(f).contactId = 'other'
			},
		],
		[
			'claim wrong user',
			(f) => {
				claim(f).verifiedUserId = 'other'
			},
		],
		[
			'claim wrong journey',
			(f) => {
				claim(f).journeyId = 'other'
			},
		],
		[
			'claim wrong contact',
			(f) => {
				claim(f).contactId = 'other'
			},
		],
		[
			'missing login',
			(f) => {
				f.rows.splice(0, 1)
			},
		],
		[
			'missing claim',
			(f) => {
				f.rows.splice(1, 1)
			},
		],
		[
			'legacy / timestamp alone',
			(f) => {
				f.rows.splice(0)
			},
		],
		[
			'login event version',
			(f) => {
				f.rows[0]!.schemaVersion = 2
			},
		],
		[
			'claim payload version',
			(f) => {
				claim(f).version = 2
			},
		],
		[
			'login payload version',
			(f) => {
				login(f).version = 2
			},
		],
		[
			'OAuth mechanism',
			(f) => {
				login(f).mechanism = 'oauth'
			},
		],
		[
			'wrong event type',
			(f) => {
				f.rows[0]!.eventType = 'User.created'
			},
		],
		[
			'wrong claim type',
			(f) => {
				f.rows[1]!.eventType = 'ContactLink'
			},
		],
		[
			'wrong event provider',
			(f) => {
				f.rows[0]!.provider = 'kit'
			},
		],
		[
			'wrong identity provider',
			(f) => {
				f.identity.provider = 'ai-hero'
			},
		],
		[
			'foreign identity',
			(f) => {
				f.identity.contactId = 'other'
			},
		],
		[
			'wrong provider identity id',
			(f) => {
				f.rows[1]!.providerIdentityId = 'foreign'
			},
		],
		[
			'wrong identity envelope',
			(f) => {
				f.rows[1]!.identityEvidence = { source: 'app', strength: 'verified' }
			},
		],
		[
			'raw email in envelope',
			(f) => {
				f.rows[1]!.identityEvidence.email = 'proof@example.test'
			},
		],
		[
			'wrong provider reference',
			(f) => {
				f.rows[1]!.providerReference = 'forged'
			},
		],
		[
			'wrong semantic identity',
			(f) => {
				f.rows[0]!.semanticIdempotencyKey = 'forged'
			},
		],
		[
			'wrong provider event id',
			(f) => {
				f.rows[1]!.providerEventId = 'forged'
			},
		],
		[
			'wrong row contact',
			(f) => {
				f.rows[0]!.contactId = 'other'
			},
		],
		[
			'wrong occurredAt',
			(f) => {
				f.rows[1]!.occurredAt = new Date('2026-09-10T16:00:02.345Z')
			},
		],
		[
			'future login observed',
			(f) => {
				login(f).observedAt = '2026-09-11T00:00:00.000Z'
				f.rows[0]!.occurredAt = new Date('2026-09-11T00:00:00.000Z')
			},
		],
		[
			'login observed before verified',
			(f) => {
				login(f).observedAt = '2026-09-10T16:00:00.100Z'
				f.rows[0]!.occurredAt = new Date('2026-09-10T16:00:00.000Z')
			},
		],
		[
			'claim before login',
			(f) => {
				login(f).observedAt = '2026-09-10T16:00:02.346Z'
				f.rows[0]!.occurredAt = new Date('2026-09-10T16:00:02.000Z')
			},
		],
		[
			'now before claim',
			(f) => {
				f.now = '2026-09-10T16:00:02.344Z'
			},
		],
		[
			'wrong commit format',
			(f) => {
				f.commit.format = 'legacy'
			},
		],
		[
			'wrong intent format',
			(f) => {
				f.intentRow.format = 'legacy'
			},
		],
		[
			'wrong origin',
			(f) => {
				f.intentRow.originatingStimulusId = 'foreign'
			},
		],
		[
			'wrong actor version',
			(f) => {
				f.intentRow.actorVersion += 1
			},
		],
		[
			'invalid commit envelope',
			(f) => {
				f.commit.commitEvidence = {
					stimulus: { type: 'VerifiedUserObserved' },
				}
			},
		],
		[
			'no canonical bind event',
			(f) => {
				f.commit.events = []
			},
		],
		[
			'malformed intent payload',
			(f) => {
				f.intentRow.intent = { type: 'BindCoupon' }
			},
		],
		[
			'wrong ordinal',
			(f) => {
				f.intentRow.ordinal = 2
			},
		],
	]
	it.each(cases)('refuses %s', async (_label, mutate) => {
		const f = ownerProofFixture()
		mutate(f)
		expect(await run(f)).toBeNull()
	})
	it.each([
		{ email: 'other@example.test', emailVerified: '2026-09-10T16:00:00.123Z' },
		{ email: 'proof@example.test', emailVerified: null },
		{ email: 'proof@example.test', emailVerified: '2026-09-10T16:00:00.124Z' },
		{ email: '  ', emailVerified: '2026-09-10T16:00:00.123Z' },
	])('refuses changed/cleared identity revision %#', async (changes) => {
		const f = ownerProofFixture()
		f.input = { ...f.input, lockedUser: { ...f.input.lockedUser, ...changes } }
		expect(await run(f)).toBeNull()
	})
	it('refuses changed contact email and email change away/back with invalidated verification', async () => {
		const f = ownerProofFixture()
		f.input = {
			...f.input,
			lockedContact: { ...f.input.lockedContact, email: 'other@example.test' },
		}
		expect(await run(f)).toBeNull()
		f.input = {
			...f.input,
			lockedContact: { ...f.input.lockedContact, email: 'proof@example.test' },
			lockedUser: { ...f.input.lockedUser, emailVerified: null },
		}
		expect(await run(f)).toBeNull()
	})
	it('never falls back to the first attestation session after a duplicate token callback', async () => {
		const f = ownerProofFixture()
		claim(f).sessionTokenHash = sessionTokenHash(
			f.secret,
			'repeated-token-new-session',
		)
		expect(await run(f)).toBeNull()
	})
	it.each(['intent', 'commit', 'event', 'identity'] as const)(
		'raises typed unavailable for %s read failure, without leaking details',
		async (method) => {
			const f = ownerProofFixture()
			f.store = {
				...f.store,
				[method]: async () => {
					throw new Error('private database detail')
				},
			}
			await expect(run(f)).rejects.toBeInstanceOf(VerifiedOwnerProofUnavailable)
			await expect(run(f)).rejects.toThrow(
				'Verified owner evidence read unavailable',
			)
		},
	)
	it('rejects arbitrary sourceReference even when the user matches', async () => {
		const f = ownerProofFixture()
		const evidence = f.commit.commitEvidence as {
			stimulus: { sourceReference: string }
		}
		evidence.stimulus.sourceReference = 'user:proof-user'
		expect(await run(f)).toBeNull()
	})
})
