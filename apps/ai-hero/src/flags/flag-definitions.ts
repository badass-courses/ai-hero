import type { FlagOption } from './flags'
import type { Environment } from './flags-env'

export const COMMERCE_ENABLED = 'commerce-enabled'
export const SHOW_TEAM_PRICING = 'show-team-pricing'
export const C5_PRICING_ENABLED = 'c5-pricing-enabled'

export type FlagConfig = {
	key: string
	name: string
	description: string
	defaultValue: Record<Environment, boolean>
	options: FlagOption<boolean>[]
}

export const FLAGS: Record<
	| typeof COMMERCE_ENABLED
	| typeof SHOW_TEAM_PRICING
	| typeof C5_PRICING_ENABLED,
	FlagConfig
> = {
	[COMMERCE_ENABLED]: {
		key: COMMERCE_ENABLED,
		name: 'Commerce Enabled',
		description: 'Controls whether commerce features are enabled.',
		defaultValue: {
			production: false, // Disabled by default in prod
			preview: false, // Disabled in preview for safety
			development: true, // Enabled in dev for local testing
			test: false, // Disabled in test unless explicitly enabled
		},
		options: [
			{ value: false, label: 'Disabled' },
			{ value: true, label: 'Enabled' },
		],
	},
	[SHOW_TEAM_PRICING]: {
		key: SHOW_TEAM_PRICING,
		name: 'Show Team Pricing',
		description: 'Controls visibility of the team pricing widget.',
		defaultValue: {
			production: false, // Hidden by default in prod
			preview: false, // Hidden in preview for safety
			development: true, // Visible in dev for local testing
			test: false, // Hidden in test unless explicitly enabled
		},
		options: [
			{ value: false, label: 'Hidden' },
			{ value: true, label: 'Visible' },
		],
	},
	[C5_PRICING_ENABLED]: {
		key: C5_PRICING_ENABLED,
		name: 'Cohort 5 pricing enabled',
		description:
			'Opens Cohort 5 display, checkout and team invoices. Off, C5 is closed. The AIH_C5_PRICING_DISABLED env override closes C5 whatever this says.',
		defaultValue: {
			production: false, // Closed until an admin opens it
			preview: false, // Closed in preview for safety
			development: true, // Open in dev for local testing
			test: false, // Closed in test unless explicitly enabled
		},
		options: [
			{ value: false, label: 'Closed' },
			{ value: true, label: 'Open' },
		],
	},
} as const

export type FlagKey = keyof typeof FLAGS
