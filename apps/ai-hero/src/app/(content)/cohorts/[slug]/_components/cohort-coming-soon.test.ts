import { describe, expect, it } from 'vitest'

import {
	cohortCallsToAction,
	cohortEnrollmentPhase,
	isCohortComingSoon,
} from './cohort-coming-soon'

describe('isCohortComingSoon', () => {
	it('is coming soon while the product is a draft', () => {
		expect(
			isCohortComingSoon({
				productState: 'draft',
				allowPurchase: undefined,
				hasCohortAccess: false,
			}),
		).toBe(true)
	})

	it('is not coming soon once the product is published', () => {
		expect(
			isCohortComingSoon({
				productState: 'published',
				allowPurchase: undefined,
				hasCohortAccess: false,
			}),
		).toBe(false)
	})

	it('respects the allowPurchase override', () => {
		expect(
			isCohortComingSoon({
				productState: 'draft',
				allowPurchase: 'true',
				hasCohortAccess: false,
			}),
		).toBe(false)
	})

	it('never shows the waitlist to someone who has the cohort', () => {
		expect(
			isCohortComingSoon({
				productState: 'draft',
				allowPurchase: undefined,
				hasCohortAccess: true,
			}),
		).toBe(false)
	})

	it('is not coming soon without a product', () => {
		expect(
			isCohortComingSoon({
				productState: undefined,
				allowPurchase: undefined,
				hasCohortAccess: false,
			}),
		).toBe(false)
	})
})

const OPEN = '2026-10-26T07:01:00.000Z'
const CLOSE = '2026-11-10T07:30:00.000Z'
const openMs = Date.parse(OPEN)
const closeMs = Date.parse(CLOSE)

/** Seeded instants spread across the months around the window, plus every boundary. */
function instants() {
	let seed = 20261012
	const random = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648
		return seed / 2147483648
	}
	const from = openMs - 90 * 86_400_000
	const to = closeMs + 90 * 86_400_000
	const out = [
		openMs - 1,
		openMs,
		openMs + 1,
		closeMs - 1,
		closeMs,
		closeMs + 1,
	]
	for (let i = 0; i < 500; i++)
		out.push(Math.floor(from + random() * (to - from)))
	return out
}

const expectedPhase = (ms: number) =>
	ms <= openMs ? 'before-open' : ms >= closeMs ? 'closed' : 'open'

const phaseAt = (now: Date) =>
	cohortEnrollmentPhase({ now, openEnrollment: OPEN, closeEnrollment: CLOSE })

describe('cohortEnrollmentPhase', () => {
	it('is before-open up to and including the open instant, open until close, then closed', () => {
		for (const ms of instants()) {
			expect(phaseAt(new Date(ms))).toBe(expectedPhase(ms))
		}
	})

	it('is not open at the exact open instant and is one millisecond later', () => {
		expect(phaseAt(new Date(openMs))).toBe('before-open')
		expect(phaseAt(new Date(openMs + 1))).toBe('open')
		expect(phaseAt(new Date(closeMs))).toBe('closed')
	})

	it('reads a Pacific-time viewer clock as the same instant', () => {
		// 12:01 AM PDT on Oct 26 is the open instant itself.
		const pacific = (time: string) => new Date(`2026-10-26T${time}-07:00`)
		expect(phaseAt(pacific('00:00:59'))).toBe('before-open')
		expect(phaseAt(pacific('00:01:00'))).toBe('before-open')
		expect(phaseAt(pacific('00:01:01'))).toBe('open')
	})

	it('treats a product without an open date as unrestricted', () => {
		expect(
			cohortEnrollmentPhase({
				now: new Date(openMs),
				openEnrollment: undefined,
				closeEnrollment: undefined,
			}),
		).toBe('open')
	})
})

describe('cohortCallsToAction', () => {
	const base = {
		productState: 'published',
		allowPurchase: undefined,
		hasCohortAccess: false,
		isOnWaitlist: false,
		hasActiveProduct: true,
		bypassSoldOut: false,
	}

	it('keeps every surface on the same side for any instant', () => {
		for (const ms of instants()) {
			const cta = cohortCallsToAction({
				...base,
				phase: phaseAt(new Date(ms)),
			})
			const waitlist = expectedPhase(ms) !== 'open'
			expect(cta.canEnroll).toBe(!waitlist)
			expect(cta.mobileCta).toBe(waitlist ? 'waitlist' : 'enroll')
			expect(cta.offerInJsonLd).toBe(!waitlist)
		}
	})

	it('shows the waitlist before open, even though the product is published', () => {
		const cta = cohortCallsToAction({ ...base, phase: 'before-open' })
		expect(cta.isComingSoon).toBe(false)
		expect(cta.isWaitlistOnly).toBe(true)
		expect(cta.mobileCta).toBe('waitlist')
		expect(cta.offerInJsonLd).toBe(false)
	})

	it('keeps the waitlist while the product is a draft', () => {
		const cta = cohortCallsToAction({
			...base,
			productState: 'draft',
			phase: 'open',
		})
		expect(cta.isWaitlistOnly).toBe(true)
		expect(cta.mobileCta).toBe('waitlist')
	})

	it('lets the allowPurchase override enroll outside the window', () => {
		const cta = cohortCallsToAction({
			...base,
			allowPurchase: 'true',
			phase: 'before-open',
		})
		expect(cta.canEnroll).toBe(true)
		expect(cta.mobileCta).toBe('enroll')
	})

	it('never points someone who has the cohort at the waitlist', () => {
		const cta = cohortCallsToAction({
			...base,
			hasCohortAccess: true,
			phase: 'before-open',
		})
		expect(cta.isWaitlistOnly).toBe(false)
		expect(cta.mobileCta).toBe('owned')
	})

	it('stops asking someone who already joined the waitlist', () => {
		for (const state of [
			{ phase: 'before-open' as const },
			{ phase: 'closed' as const },
			{ phase: 'open' as const, productState: 'draft' },
		]) {
			const cta = cohortCallsToAction({ ...base, ...state, isOnWaitlist: true })
			expect(cta.mobileCta).toBe('on-waitlist')
			expect(cta.offerInJsonLd).toBe(false)
		}
	})

	it('offers nothing when the rail has no product to act on', () => {
		expect(
			cohortCallsToAction({ ...base, phase: 'open', hasActiveProduct: false })
				.mobileCta,
		).toBe('none')
		expect(
			cohortCallsToAction({
				...base,
				phase: 'open',
				productState: undefined,
				hasActiveProduct: false,
			}).mobileCta,
		).toBe('none')
	})

	it('lets a coupon that bypasses the window buy, as it does in the rail', () => {
		for (const phase of ['before-open', 'closed'] as const) {
			const cta = cohortCallsToAction({ ...base, phase, bypassSoldOut: true })
			expect(cta.canEnroll).toBe(true)
			expect(cta.mobileCta).toBe('enroll')
			expect(cta.offerInJsonLd).toBe(true)
		}
	})

	it('keeps a draft on the waitlist whatever the coupon says', () => {
		const cta = cohortCallsToAction({
			...base,
			productState: 'draft',
			phase: 'open',
			bypassSoldOut: true,
		})
		expect(cta.canEnroll).toBe(false)
		expect(cta.mobileCta).toBe('waitlist')
	})
})
