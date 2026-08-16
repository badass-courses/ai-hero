import { format } from 'date-fns'

export const AI_CODING_CRASH_COURSE_PRODUCT_ID = 'product-ma254'
export const AI_CODING_CRASH_COURSE_SLUG = 'ai-coding-crash-course'
export const AI_CODING_CRASH_COURSE_PURCHASED_ON_FIELD =
	'purchased_ai_coding_crash_course_on'
export const AI_CODING_CRASH_COURSE_PURCHASER_TAG_ID = '22490749'
export const AI_CODING_CRASH_COURSE_PURCHASER_TAG =
	'AI Coding Crash Course Purchaser'
export const ACTIVE_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

type PurchaserCandidate = {
	email: string | null
	purchasedAt: Date
}

type KitSubscriber = {
	id: string | number
}

type KitPurchaserProjectionProvider = {
	getSubscriberByEmail: (email: string) => Promise<KitSubscriber | null>
	updateSubscriberFields?: (options: {
		subscriberId: string
		fields: Record<string, string>
	}) => Promise<KitSubscriber | null>
}

export type CrashCoursePurchaserProjectionSummary = {
	mode: 'dry-run' | 'allow-write'
	counts: {
		purchasesScanned: number
		uniquePurchasers: number
		invalidPurchasers: number
		matchedSubscribers: number
		missingSubscribers: number
		lookupFailures: number
		plannedPropertyWrites: number
		plannedTagWrites: number
		propertyWrites: number
		propertyFailures: number
		tagWrites: number
		tagFailures: number
	}
}

export function isAiCodingCrashCoursePurchase(productId: string | null) {
	return productId === AI_CODING_CRASH_COURSE_PRODUCT_ID
}

export function formatKitPurchaseDate(purchasedAt: Date) {
	return format(purchasedAt, 'yyyy-MM-dd HH:mm:ss z')
}

export async function projectExistingCrashCoursePurchasers({
	candidates,
	allowWrite,
	provider,
	tagExistingSubscriber,
}: {
	candidates: PurchaserCandidate[]
	allowWrite: boolean
	provider: KitPurchaserProjectionProvider
	tagExistingSubscriber?: (subscriberId: string) => Promise<unknown>
}): Promise<CrashCoursePurchaserProjectionSummary> {
	if (
		allowWrite &&
		(!provider.updateSubscriberFields || !tagExistingSubscriber)
	) {
		throw new Error('Kit purchaser projection writes are unavailable')
	}

	const purchasers = new Map<string, Date>()
	let invalidPurchasers = 0
	for (const candidate of candidates) {
		const email = candidate.email?.trim().toLowerCase()
		if (
			!email ||
			!email.includes('@') ||
			Number.isNaN(candidate.purchasedAt.getTime())
		) {
			invalidPurchasers += 1
			continue
		}
		const current = purchasers.get(email)
		if (!current || candidate.purchasedAt > current) {
			purchasers.set(email, candidate.purchasedAt)
		}
	}

	const counts: CrashCoursePurchaserProjectionSummary['counts'] = {
		purchasesScanned: candidates.length,
		uniquePurchasers: purchasers.size,
		invalidPurchasers,
		matchedSubscribers: 0,
		missingSubscribers: 0,
		lookupFailures: 0,
		plannedPropertyWrites: 0,
		plannedTagWrites: 0,
		propertyWrites: 0,
		propertyFailures: 0,
		tagWrites: 0,
		tagFailures: 0,
	}

	for (const [email, purchasedAt] of purchasers) {
		let subscriber: KitSubscriber | null
		try {
			subscriber = await provider.getSubscriberByEmail(email)
		} catch {
			counts.lookupFailures += 1
			continue
		}

		if (!subscriber) {
			counts.missingSubscribers += 1
			continue
		}

		counts.matchedSubscribers += 1
		counts.plannedPropertyWrites += 1
		counts.plannedTagWrites += 1
		if (!allowWrite) continue

		try {
			const subscriberId = String(subscriber.id)
			const updatedSubscriber = await provider.updateSubscriberFields?.({
				subscriberId,
				fields: {
					[AI_CODING_CRASH_COURSE_PURCHASED_ON_FIELD]:
						formatKitPurchaseDate(purchasedAt),
				},
			})
			if (String(updatedSubscriber?.id) !== subscriberId) {
				throw new Error(
					'Kit purchaser property response subscriber did not match',
				)
			}
			counts.propertyWrites += 1
			try {
				await tagExistingSubscriber?.(subscriberId)
				counts.tagWrites += 1
			} catch {
				counts.tagFailures += 1
			}
		} catch {
			counts.propertyFailures += 1
		}
	}

	return {
		mode: allowWrite ? 'allow-write' : 'dry-run',
		counts,
	}
}
