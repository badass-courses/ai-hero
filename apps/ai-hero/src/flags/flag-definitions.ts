import type { FlagOption } from './flags'
import type { Environment } from './flags-env'

export const COMMERCE_ENABLED = 'commerce-enabled'
export const SHOW_TEAM_PRICING = 'show-team-pricing'
export const C5_PRICING_ENABLED = 'c5-pricing-enabled'
export const DROVR_PROFILE_ACK_ENABLED = 'drovr-profile-ack-enabled'

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
	| typeof C5_PRICING_ENABLED
	| typeof DROVR_PROFILE_ACK_ENABLED,
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
	[DROVR_PROFILE_ACK_ENABLED]: {
		key: DROVR_PROFILE_ACK_ENABLED,
		name: 'Drovr profile ACK subsystem enabled',
		description:
			'Enables frozen profileAck registration, atomic completion and failed/partial-ACK tombstones together. OFF preserves legacy optimistic producer ACK to avoid extra sends. One-way boundary: enable only after dispatch, purge, metrics and operator reader compatibility proof.',
		defaultValue: {
			production: false,
			preview: false,
			development: false,
			test: false,
		},
		options: [
			{ value: false, label: 'Disabled' },
			{ value: true, label: 'Enabled after reader deployment proof' },
		],
	},
} as const

export type FlagKey = keyof typeof FLAGS
