import { describe, expect, it, vi } from 'vitest'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { writePurchaseRecordedContactEvents } from './lifecycle-contact-events'
import { writePurchaseRefundContactEvents } from './purchase-refund-contact-events'

const now = '2026-09-30T00:00:00.000Z'
const refund = {
	id: 're_1',
	status: 'succeeded',
	amount: 1995,
	currency: 'usd',
	created: 1790726400,
}

async function fixture() {
	const repository = new InMemorySubscriberMarketingRepository()
	const offer = repository.createContact({
		email: 'offer@example.test',
		name: null,
		userId: null,
		lifecycle: 'classified',
		isProvisional: false,
		createdAt: now,
		updatedAt: now,
	})
	const buyer = repository.createContact({
		email: 'buyer@example.test',
		name: null,
		userId: 'user-1',
		lifecycle: 'classified',
		isProvisional: false,
		createdAt: now,
		updatedAt: now,
	})
	await writePurchaseRecordedContactEvents({
		repository,
		now,
		rows: [
			{
				purchaseId: 'purch_1',
				productId: 'product-ma254',
				userId: 'user-1',
				email: 'buyer@example.test',
				status: 'Valid',
				totalAmount: '199',
				purchasedAt: now,
				evergreenOffer: {
					contactId: offer.id,
					couponId: `eoj-coupon:${'a'.repeat(64)}`,
				},
				purchaseFacts: {
					purchaseId: 'purch_1',
					couponIssueContactId: offer.id,
					amountCents: 19900,
					currency: 'usd',
					priceClass: 'coupon',
				},
			},
		],
	})
	return { repository, offer, buyer }
}

describe('refund contact capture', () => {
	it('retains original offer and buyer contacts, individual deltas, and stable ID dedup on replay', async () => {
		const { repository, offer, buyer } = await fixture()
		const redispatchContactEvent = vi.fn()
		const repo = Object.assign(repository, { redispatchContactEvent })
		const refunds = [
			refund,
			{ ...refund, id: 're_2', amount: 1005 },
			{ ...refund, id: 're_pending', status: 'pending' },
			{ ...refund, id: 're_failed', status: 'failed' },
		]
		expect(
			await writePurchaseRefundContactEvents({
				repository: repo,
				purchaseId: 'purch_1',
				refunds,
				now,
			}),
		).toEqual({ written: 4, duplicates: 0 })
		expect(
			await writePurchaseRefundContactEvents({
				repository: repo,
				purchaseId: 'purch_1',
				refunds,
				now,
			}),
		).toEqual({ written: 0, duplicates: 4 })
		expect(redispatchContactEvent).toHaveBeenCalledTimes(4)
		for (const contact of [offer, buyer]) {
			const events = await repo.findContactEventsByType(
				contact.id,
				'purchase.refunded',
			)
			expect(events.map((event) => event.domainPayload)).toEqual([
				{
					purchaseId: 'purch_1',
					refundId: 're_1',
					amountCents: 1995,
					currency: 'usd',
				},
				{
					purchaseId: 'purch_1',
					refundId: 're_2',
					amountCents: 1005,
					currency: 'usd',
				},
			])
		}
		const original = await repo.findContactEventsByType(
			buyer.id,
			'purchase.recorded',
		)
		expect(original).toHaveLength(1)
		expect(original[0]?.domainPayload).not.toHaveProperty('evergreenOffer')
		expect(original[0]?.domainPayload).toMatchObject({
			purchaseFacts: { couponIssueContactId: offer.id },
		})
	})
	it('retries when the purchase capture is not available rather than inventing a recipient', async () => {
		await expect(
			writePurchaseRefundContactEvents({
				repository: new InMemorySubscriberMarketingRepository(),
				purchaseId: 'missing',
				refunds: [refund],
			}),
		).rejects.toThrow('Purchase capture not available')
	})
})
