import type { TeamInquiryFormValues } from './team-inquiry-schema'

// EU, EEA and UK. DE and CH have priority under the separate 3.2 rule.
export const TERRITORY_COUNTRIES = [
	'AT',
	'BE',
	'BG',
	'HR',
	'CY',
	'CZ',
	'DK',
	'EE',
	'FI',
	'FR',
	'DE',
	'GR',
	'HU',
	'IE',
	'IT',
	'LV',
	'LT',
	'LU',
	'MT',
	'NL',
	'PL',
	'PT',
	'RO',
	'SK',
	'SI',
	'ES',
	'SE',
	'IS',
	'LI',
	'NO',
	'GB',
] as const

type RoutingValues = Pick<
	TeamInquiryFormValues,
	| 'country'
	| 'trainingCountry'
	| 'trainingLocation'
	| 'trainingType'
	| 'partnerPreference'
	| 'specificPartner'
>

export function suggestRoute(values: RoutingValues) {
	const partnerPreference =
		values.partnerPreference === 'specific'
			? values.specificPartner?.trim() || 'No preference'
			: 'No preference'
	if (values.trainingType === 'self-paced') {
		return {
			route: 'team-sales',
			reason: 'self-paced',
			partnerPreference: 'No preference',
		} as const
	}
	const countries = [
		values.country,
		values.trainingLocation === 'elsewhere'
			? values.trainingCountry
			: values.country,
	]
	if (countries.some((country) => country === 'DE' || country === 'CH')) {
		return { route: 'inovex', reason: '3.2', partnerPreference } as const
	}
	if (
		countries.some((country) =>
			TERRITORY_COUNTRIES.some((territory) => territory === country),
		)
	) {
		if (
			values.partnerPreference === 'specific' &&
			values.specificPartner?.trim()
		) {
			return {
				route: 'review',
				reason: '4.4-client-preference',
				partnerPreference,
			} as const
		}
		return { route: 'inovex', reason: '4.4', partnerPreference } as const
	}
	return { route: 'thisdot', reason: 'default', partnerPreference } as const
}
