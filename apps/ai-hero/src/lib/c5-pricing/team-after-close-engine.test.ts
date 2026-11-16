import {
	ENGINE_VERSION,
	price,
	type BuyerFactsData,
} from '@ai-hero/front-desk-support/pricing'
import { describe, expect, it } from 'vitest'

import {
	SYNTHETIC_LIST,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

const known = <A>(value: A) => ({ value, sourceRefs: ['test'] })
const gap = { gap: 'FactsUnavailable' } as const
const facts: BuyerFactsData = {
	order: known('team'),
	existingSeats: known(0),
	alumni: gap,
	credit: gap,
	creditUse: gap,
	legend: gap,
	ppp: known(null),
}
const decide = (
	order: BuyerFactsData['order'],
	flag: boolean | undefined = true,
) => {
	const policy = syntheticPolicy(
		flag === undefined
			? {}
			: {
					teamOrdersAfterClose: {
						value: flag,
						source: 'synthetic:team-after-close',
					},
				},
	)
	return price({
		facts: { ...facts, order },
		now: '2031-01-01T00:00:00Z',
		product: { id: policy.product, merchantUnit: SYNTHETIC_LIST, policy },
		quantity: 'value' in order && order.value === 'individual' ? 1 : 5,
		quotes: [],
	})
}

describe('vendored post-close team pricing contract', () => {
	it('uses engine 0.2.4 and the standard five-seat band after close', () => {
		expect(ENGINE_VERSION).toBe('0.2.4')
		const result = decide(known('team'))
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: 'priced',
				rule: 'team',
				amount: 450_000,
				unitAmount: 90_000,
				creditSource: null,
			},
		})
		expect(
			result.ok && result.value?.reasons.map((reason) => reason.code),
		).toEqual(expect.arrayContaining(['team-after-close', 'standard-window']))
	})

	it('keeps individual orders closed despite the team flag', () => {
		expect(decide(known('individual'))).toMatchObject({
			ok: true,
			value: { kind: 'closed' },
		})
	})

	it('holds unknown order types instead of treating them as teams', () => {
		expect(decide(gap)).toMatchObject({ ok: true, value: { kind: 'held' } })
	})

	it('keeps teams closed without the policy permission', () => {
		expect(decide(known('team'), false)).toMatchObject({
			ok: true,
			value: { kind: 'closed' },
		})
	})
})
