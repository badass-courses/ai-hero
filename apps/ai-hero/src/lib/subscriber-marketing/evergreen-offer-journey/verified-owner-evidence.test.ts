import { describe, expect, it } from 'vitest'
import {
	claimSemanticKey,
	emailFingerprint,
	emailTokenHash,
	sessionTokenHash,
	emailTokenLoginObservedSchema,
	offerClaimObservedSchema,
	emailTokenLoginEventRow,
	loginSemanticKey,
	resolveOwnerContact,
} from './verified-owner-evidence'
import { ownerProofFixture } from './verified-owner-proof.fixtures'

describe('dormant verified owner evidence contract', () => {
	it('strict versioned payloads roundtrip and reject extra/raw fields', () => {
		const f = ownerProofFixture()
		expect(
			emailTokenLoginObservedSchema.parse(JSON.parse(JSON.stringify(f.login))),
		).toEqual(f.login)
		expect(
			offerClaimObservedSchema.parse(JSON.parse(JSON.stringify(f.claim))),
		).toEqual(f.claim)
		for (const field of ['token', 'email', 'sessionToken', 'sourceReference']) {
			expect(
				emailTokenLoginObservedSchema.safeParse({
					...f.login,
					[field]: 'untrusted',
				}).success,
			).toBe(false)
			expect(
				offerClaimObservedSchema.safeParse({ ...f.claim, [field]: 'untrusted' })
					.success,
			).toBe(false)
		}
		expect(
			emailTokenLoginObservedSchema.safeParse({ ...f.login, version: 2 })
				.success,
		).toBe(false)
	})
	it('HMAC domains and secrets separate email, login token and session; email normalization is conservative', () => {
		expect(emailFingerprint('fixture', ' Proof@Example.test ')).toBe(
			emailFingerprint('fixture', 'proof@example.test'),
		)
		const values = [
			emailFingerprint('fixture', 'proof@example.test'),
			sessionTokenHash('fixture', 'proof@example.test'),
			emailTokenHash('fixture', 'proof@example.test'),
			emailFingerprint('other', 'proof@example.test'),
		]
		expect(new Set(values).size).toBe(4)
		expect(() => emailFingerprint('', 'proof@example.test')).toThrow()
		expect(() => emailFingerprint('fixture', '  ')).toThrow()
	})
	it('dedupes one attestation per token/contact, not per session; claim identity is deterministic and bounded', () => {
		const f = ownerProofFixture()
		const repeated = {
			...f.login,
			sessionTokenHash: sessionTokenHash(f.secret, 'second-session'),
		}
		expect(loginSemanticKey(repeated)).toBe(loginSemanticKey(f.login))
		expect(claimSemanticKey(f.claim)).toBe(claimSemanticKey({ ...f.claim }))
		expect(
			claimSemanticKey({ ...f.claim, attestationEventId: 'different' }),
		).not.toBe(claimSemanticKey(f.claim))
		expect(loginSemanticKey(f.login).length).toBeLessThan(255)
		expect(
			claimSemanticKey({ ...f.claim, journeyId: 'j'.repeat(500) }).length,
		).toBeLessThan(255)
	})
	it('preserves payload milliseconds and floors SQL occurredAt; no raw token/session/email in rows', () => {
		const f = ownerProofFixture()
		expect(f.rows[0]!.occurredAt.toISOString()).toBe('2026-09-10T16:00:01.000Z')
		expect(f.rows[0]!.payloadSummary.observedAt).toBe(f.login.observedAt)
		const text = JSON.stringify(f.rows)
		for (const raw of [
			'proof@example.test',
			'synthetic-session',
			'synthetic-token',
		])
			expect(text).not.toContain(raw)
		expect(f.rows[0]).toMatchObject({
			provider: 'ai-hero',
			privacyLevel: 'restricted',
			providerIdentityId: f.identity.id,
			identityEvidence: {
				source: 'ai-hero',
				strength: 'strong',
				providerIdentity: {
					provider: 'kit',
					externalId: f.identity.externalId,
				},
			},
		})
	})
	it('holds missing/ambiguous contact resolution; never fans out and rejects foreign identity row builders', () => {
		for (const ids of [[], ['other'], ['owner', 'other'], ['owner', 'owner']])
			expect(resolveOwnerContact(ids, 'owner')).toMatchObject({ type: 'Held' })
		expect(resolveOwnerContact(['owner'], 'owner')).toEqual({
			type: 'Resolved',
			contactId: 'owner',
		})
		const f = ownerProofFixture()
		expect(() =>
			emailTokenLoginEventRow({
				resolution: resolveOwnerContact(
					[f.identity.contactId],
					f.identity.contactId,
				),
				id: 'event',
				identity: { ...f.identity, provider: 'kit', contactId: 'other' },
				payload: f.login,
			}),
		).toThrow('Owner identity mismatch')
	})
	it('row builder cannot accept a held contact resolution', () => {
		const f = ownerProofFixture()
		expect(() =>
			emailTokenLoginEventRow({
				id: 'event',
				resolution: resolveOwnerContact(
					[f.identity.contactId, 'other'],
					f.identity.contactId,
				),
				identity: { ...f.identity, provider: 'kit' },
				payload: f.login,
			}),
		).toThrow('Owner contact resolution held')
	})
	it.each([
		'verifiedAt',
		'observedAt',
		'sessionTokenHash',
		'tokenHash',
		'emailFingerprint',
	])('rejects malformed %s', (field) => {
		const f = ownerProofFixture()
		expect(
			emailTokenLoginObservedSchema.safeParse({
				...f.login,
				[field]: 'not-valid',
			}).success,
		).toBe(false)
	})
})
