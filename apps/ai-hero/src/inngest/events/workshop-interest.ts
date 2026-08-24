import type { ConversionSurface } from '@/lib/cta/conversion-intent'

export const WORKSHOP_INTEREST_REQUESTED_EVENT =
	'workshop/interest.requested' as const

export type WorkshopInterestRequested = {
	name: typeof WORKSHOP_INTEREST_REQUESTED_EVENT
	data: {
		email: string
		name?: string
		workshopSlug: string
		surface: ConversionSurface
		expressedAt: string
		via: 'cookie' | 'session'
		subscriberId?: number
	}
}
