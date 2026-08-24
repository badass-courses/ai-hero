import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
	getActivationDelayMs,
	TimedPromoBarSwitch,
} from './timed-promo-bar-switch'

describe('TimedPromoBarSwitch', () => {
	it('arms the exact remaining delay and activates at the boundary', () => {
		const startsAt = '2026-08-17T07:00:00.000Z'
		expect(
			getActivationDelayMs(
				startsAt,
				new Date('2026-08-17T06:59:59.999Z').getTime(),
			),
		).toBe(1)
		expect(
			getActivationDelayMs(
				startsAt,
				new Date('2026-08-17T07:00:00.000Z').getTime(),
			),
		).toBe(0)
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
