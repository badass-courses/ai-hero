import { describe, expect, it } from 'vitest'

import { suggestRoute, TERRITORY_COUNTRIES } from './training-route'

const live = { trainingType: 'live', country: 'US' } as const

describe('training route suggestion', () => {
	it.each(['DE', 'CH'])(
		'gives %s priority over location and preference',
		(country) => {
			for (const countries of [
				{ country },
				{
					country: 'US',
					trainingLocation: 'elsewhere' as const,
					trainingCountry: country,
				},
			]) {
				expect(
					suggestRoute({
						...live,
						...countries,
						partnerPreference: 'specific',
						specificPartner: 'Other partner',
					}),
				).toEqual({
					route: 'inovex',
					reason: '3.2',
					partnerPreference: 'Other partner',
				})
			}
		},
	)
	it.each(TERRITORY_COUNTRIES.filter((code) => code !== 'DE'))(
		'routes %s to inovex unless a named partner needs desk review',
		(country) => {
			for (const countries of [
				{ country },
				{ trainingLocation: 'elsewhere' as const, trainingCountry: country },
			]) {
				expect(suggestRoute({ ...live, ...countries })).toEqual({
					route: 'inovex',
					reason: '4.4',
					partnerPreference: 'No preference',
				})
				expect(
					suggestRoute({
						...live,
						...countries,
						partnerPreference: 'specific',
						specificPartner: ' Requested partner ',
					}),
				).toEqual({
					route: 'review',
					reason: '4.4-client-preference',
					partnerPreference: 'Requested partner',
				})
			}
		},
	)
	it.each(['US', 'CA', 'AU', 'JP', 'BR'])(
		'defaults %s to This Dot',
		(country) => {
			expect(suggestRoute({ ...live, country })).toMatchObject({
				route: 'thisdot',
				reason: 'default',
			})
		},
	)
	it.each(['DE', 'CH', 'GB', 'US'])(
		'routes self-paced from %s to team sales',
		(country) => {
			expect(
				suggestRoute({ ...live, country, trainingType: 'self-paced' }),
			).toMatchObject({ route: 'team-sales', reason: 'self-paced' })
		},
	)
	it('ignores a stale partner name when no preference is selected', () => {
		expect(
			suggestRoute({
				...live,
				country: 'GB',
				partnerPreference: 'none',
				specificPartner: 'Other partner',
			}),
		).toEqual({
			route: 'inovex',
			reason: '4.4',
			partnerPreference: 'No preference',
		})
	})
	it('ignores a stale alternate country when the same country is selected', () => {
		expect(
			suggestRoute({ ...live, trainingLocation: 'same', trainingCountry: 'DE' })
				.route,
		).toBe('thisdot')
	})
})
