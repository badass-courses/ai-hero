import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
	getActivationDelayMs,
	isWithinPromoWindow,
	TimedPromoBarSwitch,
} from './timed-promo-bar-switch'

describe('TimedPromoBarSwitch', () => {
	it('arms the exact remaining delay before launch', () => {
		const startsAt = '2026-08-17T07:00:00.000Z'
		expect(
			getActivationDelayMs(
				startsAt,
				new Date('2026-08-17T06:59:59.999Z').getTime(),
			),
		).toBe(1)
	})

	// Once the last boundary is behind us the promo's state can never change
	// again, so there is nothing left to schedule. The hook sets `active` from
	// the window itself before it looks at the delay, so null here means "stop
	// arming timers", not "inactive".
	it('has no boundary left once the start has passed', () => {
		expect(
			getActivationDelayMs(
				'2026-08-17T07:00:00.000Z',
				new Date('2026-08-17T07:00:00.000Z').getTime(),
			),
		).toBeNull()
	})

	// The regression this whole gate exists for: on 2026-08-25 the bar was
	// still promising "$199 through August 24" because a promo could only ever
	// switch itself ON.
	it('arms the end boundary while the promo is live', () => {
		expect(
			getActivationDelayMs(
				{
					startsAt: '2026-08-17T07:00:00.000Z',
					endsAt: '2026-08-25T07:00:00.000Z',
				},
				new Date('2026-08-25T06:59:59.000Z').getTime(),
			),
		).toBe(1000)
	})

	it('is live only inside the half-open window', () => {
		const activeWindow = {
			startsAt: '2026-08-17T07:00:00.000Z',
			endsAt: '2026-08-25T07:00:00.000Z',
		}
		const at = (iso: string) =>
			isWithinPromoWindow(activeWindow, new Date(iso).getTime())

		expect(at('2026-08-17T06:59:59.999Z')).toBe(false)
		expect(at('2026-08-17T07:00:00.000Z')).toBe(true)
		expect(at('2026-08-25T06:59:59.999Z')).toBe(true)
		// Inclusive here and the bar outlives the coupon by a millisecond.
		expect(at('2026-08-25T07:00:00.000Z')).toBe(false)
	})

	it('treats an unparseable bound as no bound rather than blanking the bar', () => {
		expect(isWithinPromoWindow({ startsAt: 'not a date' })).toBe(true)
		expect(isWithinPromoWindow({ endsAt: 'not a date' })).toBe(true)
	})

	it('renders the fallback before launch', () => {
		const markup = renderToStaticMarkup(
			<TimedPromoBarSwitch
				startsAt="2026-08-17T07:00:00.000Z"
				initialFeaturedActive={false}
				featured={<span>Crash Course</span>}
				fallback={<span>Wizard</span>}
			/>,
		)

		expect(markup).toContain('Wizard')
		expect(markup).not.toContain('Crash Course')
	})

	it('renders the featured promo at launch', () => {
		const markup = renderToStaticMarkup(
			<TimedPromoBarSwitch
				startsAt="2026-08-17T07:00:00.000Z"
				initialFeaturedActive
				featured={<span>Crash Course</span>}
				fallback={<span>Wizard</span>}
			/>,
		)

		expect(markup).toContain('Crash Course')
		expect(markup).not.toContain('Wizard')
	})
})
