import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { syntheticRevisionScope } from './revision-delivery.fixtures'
import {
	mappingIdentity,
	mappingCoreSchema,
	mappingDigest,
	mappingEventRow,
	readMappingEventRow,
	mappingReceipt,
} from './original-delivery-mapping'

function core() {
	const manifest = syntheticRevisionScope().manifest
	const message = manifest.messages[0]!
	return mappingCoreSchema.parse({
		format: 'evergreen.delivery-mapping-record.v1',
		contactId: 'contact',
		journeyId: 'journey',
		idempotencyKey: 'intent',
		claimToken: randomUUID(),
		slotId: message.slotId,
		contentResourceId: message.contentResourceId,
		presentation: message.presentation,
		revision: manifest.revision,
		bindingArtifactSha256: manifest.bindingArtifactSha256,
		bindingEvidenceId: manifest.bindingEvidenceId,
		bodySha256: message.bodySha256,
		sequenceId: message.sequenceId,
		recordedAt: '2026-09-08T02:00:00.123Z',
	})
}
describe('original mapping immutable storage codec', () => {
	it('binds the key to journey, intent and internal claim UUID and hashes fixed-order stored values', () => {
		const c = core()
		const reversed = Object.fromEntries(Object.entries(c).reverse())
		expect(mappingDigest(reversed)).toBe(mappingDigest(c))
		expect(mappingIdentity(c).id).toMatch(/^eodm_[a-f0-9]{64}$/)
		expect(mappingIdentity({ ...c, claimToken: randomUUID() })).not.toEqual(
			mappingIdentity(c),
		)
		expect(
			mappingDigest({ ...c, recordedAt: '2026-09-08T02:00:00.124Z' }),
		).not.toBe(mappingDigest(c))
	})
	it('roundtrips full envelope with millisecond core and floor-second row time, no raw identity data', () => {
		const c = core()
		const refs = { sourceEventId: 'source', providerIdentityId: 'identity' }
		const row = {
			...mappingEventRow(c, refs),
			createdAt: new Date(c.recordedAt),
		}
		expect(row.occurredAt.toISOString()).toBe('2026-09-08T02:00:00.000Z')
		expect(readMappingEventRow(row, refs)).toEqual(c)
		expect(mappingReceipt(c).sourceReceiptSha256).toBe(mappingDigest(c))
		expect(row.payloadSummary).toMatchObject({
			keywords: [],
			restrictedPayloadStored: false,
		})
		expect(row.identityEvidence).toEqual({ source: 'ai-hero', ...refs })
	})
	it.each([
		'provider',
		'providerEventId',
		'providerReference',
		'privacyLevel',
		'eventType',
		'semanticIdempotencyKey',
		'contactId',
		'id',
		'schemaVersion',
		'occurredAt',
		'createdAt',
		'identityEvidence',
		'payloadSummary',
	])('rejects envelope corruption %s', (field) => {
		const c = core()
		const refs = { sourceEventId: 'source', providerIdentityId: 'identity' }
		expect(() =>
			readMappingEventRow(
				{
					...mappingEventRow(c, refs),
					createdAt: new Date(c.recordedAt),
					[field]: 'wrong',
				},
				refs,
			),
		).toThrow()
	})
	it.each([
		'claimToken',
		'recordedAt',
		'sequenceId',
		'bodySha256',
		'contactId',
	])('rejects malformed %s', (field) => {
		expect(
			mappingCoreSchema.safeParse({
				...core(),
				[field]: field === 'sequenceId' ? Number.MAX_SAFE_INTEGER + 1 : '',
			}).success,
		).toBe(false)
	})
	it('rejects raw credential/body fields rather than persisting unknown keys', () => {
		for (const field of ['email', 'name', 'authToken', 'body', 'secret'])
			expect(
				mappingCoreSchema.safeParse({ ...core(), [field]: 'private' }).success,
			).toBe(false)
	})
})
