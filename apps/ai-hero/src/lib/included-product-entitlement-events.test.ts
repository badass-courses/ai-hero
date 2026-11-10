import { describe, expect, it } from 'vitest'

import {
	drovrEntitlementEventsFor,
	entitlementEventsEnabled,
	includedEntitlementFacts,
} from './included-product-entitlement-events'
import { fanOutOwnedEvents } from './subscriber-marketing/drovr-ownership'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	mapDrovrShadowFact,
} from './subscriber-marketing/drovr-shadow-emitter'
import {
	buildEntitlementRecordedEvent,
	type EntitlementRecordedSource,
} from './subscriber-marketing/lifecycle-contact-events'

/**
 * A copy of drovr's wire contract (packages/ownership/src/events.ts in
 * drovr #3411), not an import: both payloads are JSON objects of non-empty
 * strings; granted needs entitlementId and productId and may carry
 * viaProductId and bundlePolicy; revoked needs entitlementId. drovr ignores
 * other keys, so this also refuses them: money must never ride along.
 */
const DROVR_PAYLOAD_FIXTURE = {
	'entitlement.granted': {
		required: ['entitlementId', 'productId'],
		optional: ['viaProductId', 'bundlePolicy'],
	},
	'entitlement.revoked': { required: ['entitlementId'], optional: [] },
} as const

function decodeLikeDrovr(
	type: keyof typeof DROVR_PAYLOAD_FIXTURE,
	wire: string,
): Record<string, string> | undefined {
	const value: unknown = JSON.parse(wire)
	if (!value || typeof value !== 'object' || Array.isArray(value)) return
	const shape = DROVR_PAYLOAD_FIXTURE[type]
	const allowed: readonly string[] = [...shape.required, ...shape.optional]
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.some(([key]) => !allowed.includes(key))) return
	if (entries.some(([, field]) => typeof field !== 'string' || field === ''))
		return
	if (shape.required.some((key) => !(key in value))) return
	return value as Record<string, string>
}

const source = (
	overrides: Partial<EntitlementRecordedSource> = {},
): EntitlementRecordedSource => ({
	change: 'granted',
	entitlementId: 'c5_cc_synthetic',
	userId: 'user-1',
	email: 'holder@example.test',
	productId: 'product-ma254',
	viaProductId: 'product-s00zs',
	bundlePolicy: 'c5-includes-crash-course-v1',
	occurredAt: '2026-11-01T00:00:00.000Z',
	...overrides,
})

const wireEvents = (row: EntitlementRecordedSource, contactId = 'contact-1') => {
	const normalized = buildEntitlementRecordedEvent(row, {
		userId: row.userId,
		source: 'ai-hero',
		strength: 'strong',
	})
	return mapDrovrShadowFact({
		kind: 'contact-event',
		event: {
			...normalized,
			id: 'contact-event-1',
			contactId,
			providerIdentityId: 'identity-1',
			createdAt: row.occurredAt,
		},
	})
}

describe('entitlement events on the wire', () => {
	it('entitlement.granted decodes against the drovr payload shape', () => {
		const directory = wireEvents(source()).find(
			(event) => event.journeyId === DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
		)!
		expect(directory).toMatchObject({
			tenantId: DROVR_AUTHORITY_TENANT_ID,
			contactId: 'contact-1',
			type: 'entitlement.granted',
			idempotencyKey: 'aihero:ai-hero:entitlement.granted:c5_cc_synthetic',
		})
		expect(
			decodeLikeDrovr('entitlement.granted', JSON.stringify(directory.payload)),
		).toEqual({
			entitlementId: 'c5_cc_synthetic',
			productId: 'product-ma254',
			viaProductId: 'product-s00zs',
			bundlePolicy: 'c5-includes-crash-course-v1',
		})
	})

	it('entitlement.revoked decodes against the drovr payload shape, under its own key', () => {
		const directory = wireEvents(source({ change: 'revoked' })).find(
			(event) => event.journeyId === DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
		)!
		expect(directory.type).toBe('entitlement.revoked')
		expect(directory.idempotencyKey).toBe(
			'aihero:ai-hero:entitlement.revoked:c5_cc_synthetic',
		)
		expect(
			decodeLikeDrovr('entitlement.revoked', JSON.stringify(directory.payload)),
		).toEqual({ entitlementId: 'c5_cc_synthetic' })
	})

	it('reaches an owned evergreen pitch actor, as a purchase does', () => {
		const delivered = fanOutOwnedEvents(
			wireEvents(source()),
			new Set(['contact-1']),
			new Set(),
		).filter((event) => event.tenantId === DROVR_AUTHORITY_TENANT_ID)
		expect(
			delivered.map((event) => [event.journeyId, event.idempotencyKey]),
		).toEqual([
			[
				DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
				'aihero:ai-hero:entitlement.granted:c5_cc_synthetic',
			],
			[
				DROVR_EVERGREEN_OFFER_JOURNEY_ID,
				'owner:aihero:ai-hero:entitlement.granted:c5_cc_synthetic',
			],
		])
	})

	it('posts an uncontacted holder under the mirror key, to the authority only', async () => {
		const posted = await drovrEntitlementEventsFor(source(), 'drovr-contact-9')
		expect(
			posted.map((event) => [
				event.tenantId,
				event.contactId,
				event.idempotencyKey,
			]),
		).toEqual([
			[
				DROVR_AUTHORITY_TENANT_ID,
				'drovr-contact-9',
				'aihero:ai-hero:entitlement.granted:c5_cc_synthetic',
			],
		])
	})

	it('drops a stored event whose payload is unreadable instead of posting a guess', () => {
		const normalized = buildEntitlementRecordedEvent(source(), {
			source: 'ai-hero',
			strength: 'strong',
		})
		expect(
			mapDrovrShadowFact({
				kind: 'contact-event',
				event: {
					...normalized,
					domainPayload: { entitlement: { productId: 'product-ma254' } },
					id: 'contact-event-1',
					contactId: 'contact-1',
					providerIdentityId: 'identity-1',
					createdAt: normalized.occurredAt,
				},
			}),
		).toEqual([])
	})
})

describe('included entitlement facts', () => {
	const row = {
		id: 'c5_cc_row',
		userId: 'user-1',
		createdAt: '2026-10-01T00:00:00.000Z',
		deletedAt: null,
		metadata: {
			contentIds: ['workshop-2ozd9'],
			bundlePolicy: 'c5-includes-crash-course-v1',
			includedByProductId: 'product-s00zs',
		},
	}

	it('ignores the Discord role rows and rows of another policy', () => {
		expect(
			includedEntitlementFacts([
				{
					...row,
					id: 'c5_cc_dr_role',
					metadata: {
						...row.metadata,
						contentIds: undefined,
						discordRoleId: 'r',
					},
				},
				{ ...row, metadata: { ...row.metadata, bundlePolicy: 'other-v1' } },
				{ ...row, id: 'other_prefix' },
			]),
		).toEqual([])
	})

	it('dates a grant at its row, so the backfill and the live path send the same event', () => {
		const [fact] = includedEntitlementFacts([row], '2026-11-01T00:00:00.000Z')
		expect(fact).toMatchObject({
			change: 'granted',
			entitlementId: 'c5_cc_row',
			occurredAt: '2026-10-01T00:00:00.000Z',
		})
	})
})

describe('AIH_ENTITLEMENT_EVENTS_ENABLED', () => {
	it.each([
		[undefined, false],
		['', false],
		['off', false],
		['false', false],
		['on', true],
		['true', true],
		['1', true],
	])('%s reads as %s', (value, enabled) => {
		expect(
			entitlementEventsEnabled({ AIH_ENTITLEMENT_EVENTS_ENABLED: value }),
		).toBe(enabled)
	})
})
