import { describe, expect, it } from 'vitest'

import {
	runEntitlementBackfill,
	type BackfillEntitlement,
	type EntitlementBackfillPorts,
} from './drovr-entitlement-backfill'
import { deliverResolvedPurchaseEvents } from './drovr-purchase-resolve'

const fact = (
	n: number,
	change: BackfillEntitlement['change'] = 'granted',
): BackfillEntitlement => ({
	change,
	entitlementId: `c5_cc_synthetic_${n}`,
	userId: `user-${n}`,
	email: `holder${n}@example.test`,
	productId: 'product-ma254',
	viaProductId: 'product-s00zs',
	bundlePolicy: 'c5-includes-crash-course-v1',
	occurredAt: '2026-10-01T00:00:00.000Z',
})

/**
 * drovr's /events, as far as a backfill can see it: the event log keyed by
 * tenant, contact, journey and idempotency key, where a known key is a 200
 * that records nothing.
 */
function fakeDrovr() {
	const log = new Map<string, string>()
	let appended = 0
	const fetcher = (async (_url: string, init?: RequestInit) => {
		const event = JSON.parse(String(init?.body))
		const key = [
			event.tenantId,
			event.contactId,
			event.journeyId,
			event.idempotencyKey,
		].join('|')
		if (!log.has(key)) {
			log.set(key, String(init?.body))
			appended += 1
		}
		return new Response('{}', { status: 202 })
	}) as typeof fetch
	return {
		log,
		appended: () => appended,
		deliver: ((args) =>
			deliverResolvedPurchaseEvents({
				...args,
				fetcher,
			})) satisfies EntitlementBackfillPorts['deliver'],
	}
}

const resolve: EntitlementBackfillPorts['resolve'] = async () =>
	new Map([
		['holder1@example.test', { status: 'resolved', contactId: 'drv-1' }],
		['holder2@example.test', { status: 'missing' }],
		['holder3@example.test', { status: 'conflict' }],
		['holder4@example.test', { status: 'resolved', contactId: 'drv-4' }],
	])
const facts = [fact(1), fact(2), fact(3), fact(4, 'revoked')]
const ingestConfig = { ingestUrl: 'https://drovr.test/events', apiKey: 'key' }
const sleep = async () => undefined

describe('runEntitlementBackfill', () => {
	it('backfill-dry-run-posts-nothing', async () => {
		const drovr = fakeDrovr()
		const counts = await runEntitlementBackfill({
			facts,
			allowWrite: false,
			ingestConfig,
			ports: { resolve, deliver: drovr.deliver, sleep },
		})
		expect(drovr.log.size).toBe(0)
		expect(counts).toMatchObject({
			facts: 4,
			granted: 3,
			revoked: 1,
			resolved: 2,
			missing: 1,
			conflict: 1,
			posted: 0,
		})
	})

	it('posts resolved holders once each, to the authority directory', async () => {
		const drovr = fakeDrovr()
		const counts = await runEntitlementBackfill({
			facts,
			allowWrite: true,
			ingestConfig,
			ports: { resolve, deliver: drovr.deliver, sleep },
		})
		expect(counts).toMatchObject({ posted: 2, accepted: 2, rejected: 0 })
		expect([...drovr.log.keys()].sort()).toEqual([
			'org-aihero|drv-1|contact-directory|aihero:ai-hero:entitlement.granted:c5_cc_synthetic_1',
			'org-aihero|drv-4|contact-directory|aihero:ai-hero:entitlement.revoked:c5_cc_synthetic_4',
		])
	})

	it('backfill-rerun-is-a-no-op', async () => {
		const drovr = fakeDrovr()
		const run = () =>
			runEntitlementBackfill({
				facts,
				allowWrite: true,
				ingestConfig,
				ports: { resolve, deliver: drovr.deliver, sleep },
			})
		await run()
		const before = new Map(drovr.log)
		const appendedBefore = drovr.appended()
		await run()
		expect(drovr.appended()).toBe(appendedBefore)
		expect(drovr.log).toEqual(before)
	})

	it('writes the snapshot before the first post and refuses to write without the ingest config', async () => {
		const drovr = fakeDrovr()
		const order: string[] = []
		await runEntitlementBackfill({
			facts,
			allowWrite: true,
			ingestConfig,
			ports: {
				resolve,
				deliver: async (args) => {
					order.push('post')
					return drovr.deliver(args)
				},
				writeSnapshot: async (rows) => {
					order.push(`snapshot:${rows.length}`)
				},
				sleep,
			},
		})
		expect(order).toEqual(['snapshot:2', 'post', 'post'])
		await expect(
			runEntitlementBackfill({
				facts,
				allowWrite: true,
				ports: { resolve, deliver: drovr.deliver, sleep },
			}),
		).rejects.toThrow('ingest config')
	})
})
