import {
	readCouponEvidence,
	type CommerceCouponRow,
} from './subscriber-marketing/evergreen-offer-journey/coupon-authority'
import { EVERGREEN_OFFER_AMOUNT_OFF_CENTS } from './subscriber-marketing/evergreen-offer-journey/domain'

type Awaitable<T> = T | Promise<T>

type MerchantCouponRecord = {
	id: string
	type?: string | null
	status?: number
	amountDiscount?: number | null
}

type SiteCouponRecord = {
	id: string
	merchantCouponId?: string | null
	restrictedToProductId?: string | null
	fields?: Record<string, unknown> | null
	status?: number
	expires?: Date | null
	maxUses?: number
	usedCount?: number
	paidCouponUsedUp?: true
}

type EntitlementRecord = {
	userId?: string | null
	sourceType: string
	sourceId: string
	entitlementType: string
	deletedAt?: Date | null
	expiresAt?: Date | null
}

export type ExclusiveCouponAuthorizationAdapter = {
	getMerchantCoupon(
		merchantCouponId: string,
	): Awaitable<MerchantCouponRecord | null>
	getCoupon(couponId: string): Awaitable<SiteCouponRecord | null>
	getCouponForDisplay?(couponId: string): Awaitable<SiteCouponRecord | null>
	getEntitlementTypeByName(
		name: string,
	): Awaitable<{ id: string } | null | undefined>
	getEntitlementsForUser(input: {
		userId: string
		sourceType: 'COUPON'
		entitlementType: string
	}): Awaitable<EntitlementRecord[]>
}

type AuthorizeExclusiveCouponSelectionInput = {
	adapter: ExclusiveCouponAuthorizationAdapter
	verifiedUserId?: string
	productId: string
	quantity: number
	requestedMerchantCouponId?: string
	requestedSiteCouponId?: string
	now?: Date
}

export type ExclusiveCouponAuthorizationDecision = {
	authorized: boolean
	protectedMerchantCoupon: boolean
	protectedSiteCoupon: boolean
	/** The denied selection was a PPP coupon; server pricing may re-derive PPP. */
	requestedPPP?: boolean
	paidCouponUsedUp?: true
	entitlementCouponId?: string
	entitlementMerchantCouponId?: string
}

const isActiveEntitlement = (
	entitlement: EntitlementRecord,
	verifiedUserId: string,
	entitlementTypeId: string,
	now: Date,
) =>
	entitlement.userId === verifiedUserId &&
	entitlement.sourceType === 'COUPON' &&
	entitlement.entitlementType === entitlementTypeId &&
	!entitlement.deletedAt &&
	(!entitlement.expiresAt || entitlement.expiresAt > now)

const couponPermitsProduct = (coupon: SiteCouponRecord, productId: string) =>
	!coupon.restrictedToProductId || coupon.restrictedToProductId === productId

const couponIsActive = (coupon: SiteCouponRecord, now: Date) => {
	if (coupon.status !== 1) return false
	if (coupon.expires && coupon.expires <= now) return false
	if (coupon.maxUses === -1) return true
	return (
		typeof coupon.maxUses === 'number' &&
		typeof coupon.usedCount === 'number' &&
		coupon.usedCount < coupon.maxUses
	)
}

// Existing evergreen rows are exclusive and remain attributed to the issuing
// contact, but Joel opted to make their links redeemable by anyone. Do not
// weaken other exclusive credits: require the entire canonical issued-row
// evidence, the matching merchant discount, and a currently usable coupon.
const isShareableEvergreenCoupon = (
	merchantCoupon: MerchantCouponRecord,
	siteCoupon: SiteCouponRecord | null,
	productId: string,
	quantity: number,
	now: Date,
) => {
	if (
		quantity !== 1 ||
		merchantCoupon.type !== 'special' ||
		merchantCoupon.status !== 1 ||
		merchantCoupon.amountDiscount !== EVERGREEN_OFFER_AMOUNT_OFF_CENTS ||
		!siteCoupon ||
		siteCoupon.merchantCouponId !== merchantCoupon.id ||
		!couponIsActive(siteCoupon, now) ||
		!couponPermitsProduct(siteCoupon, productId)
	) {
		return false
	}
	try {
		const parsedRow = siteCoupon as CommerceCouponRow
		// DrizzleAdapter.getCoupon parses through couponSchema before this gate.
		// Its z.coerce.number() turns SQL NULL percentageDiscount into 0;
		// normalize only that no-percentage value for canonical row evidence.
		const parsedPercentage = (siteCoupon as { percentageDiscount?: unknown })
			.percentageDiscount
		const evidenceRow = {
			...parsedRow,
			percentageDiscount:
				parsedPercentage === 0 ? null : parsedRow.percentageDiscount,
		}
		return readCouponEvidence(evidenceRow).coupon.terms.productId === productId
	} catch {
		return false
	}
}

const isPublicCouponProvenance = ({
	merchantCoupon,
	siteCoupon,
	productId,
	now,
}: {
	merchantCoupon: MerchantCouponRecord
	siteCoupon: SiteCouponRecord | null
	productId: string
	now: Date
}) =>
	merchantCoupon.type === 'special' &&
	merchantCoupon.status === 1 &&
	Boolean(siteCoupon && couponIsActive(siteCoupon, now)) &&
	siteCoupon?.merchantCouponId === merchantCoupon.id &&
	siteCoupon.fields?.exclusive !== true &&
	couponPermitsProduct(siteCoupon, productId)

/**
 * A MerchantCoupon id selects provider discount data. It does not prove that
 * the caller may use the discount. PPP is also stripped here and can only be
 * reselected by server pricing from country, quantity, and purchase state.
 */
export async function authorizeExclusiveCouponSelection({
	adapter,
	verifiedUserId,
	productId,
	quantity,
	requestedMerchantCouponId,
	requestedSiteCouponId,
	now = new Date(),
}: AuthorizeExclusiveCouponSelectionInput): Promise<ExclusiveCouponAuthorizationDecision> {
	const getCoupon = (adapter.getCouponForDisplay ?? adapter.getCoupon).bind(
		adapter,
	)
	const requestedSiteCoupon = requestedSiteCouponId
		? await getCoupon(requestedSiteCouponId)
		: null
	const protectedSiteCoupon = requestedSiteCoupon?.fields?.exclusive === true
	if (
		requestedSiteCoupon?.paidCouponUsedUp &&
		couponPermitsProduct(requestedSiteCoupon, productId)
	) {
		// A regional selector is consent, not authority. Drop the spent link and
		// let the existing PPP path recompute the offer from trusted country.
		const selectedMerchantCoupon = requestedMerchantCouponId
			? await adapter.getMerchantCoupon(requestedMerchantCouponId)
			: null
		if (
			selectedMerchantCoupon?.type === 'ppp' &&
			selectedMerchantCoupon.status === 1
		) {
			return {
				authorized: false,
				protectedMerchantCoupon: true,
				protectedSiteCoupon,
				paidCouponUsedUp: true,
				requestedPPP: true,
			}
		}
		// Treat the exhausted link as absent when resolving independent credits.
		const entitlement = await findEntitlementCoupon({
			adapter,
			getCoupon,
			verifiedUserId,
			productId,
			quantity,
			now,
		})
		return {
			authorized: Boolean(entitlement),
			protectedMerchantCoupon: Boolean(requestedMerchantCouponId),
			protectedSiteCoupon,
			paidCouponUsedUp: true,
			...(entitlement && {
				entitlementCouponId: entitlement.id,
				entitlementMerchantCouponId: entitlement.merchantCouponId,
			}),
		}
	}
	const merchantCouponId =
		requestedMerchantCouponId || requestedSiteCoupon?.merchantCouponId
	const requestedMerchantCoupon = merchantCouponId
		? await adapter.getMerchantCoupon(merchantCouponId)
		: null
	const publicProvenance = requestedMerchantCoupon
		? isPublicCouponProvenance({
				merchantCoupon: requestedMerchantCoupon,
				siteCoupon: requestedSiteCoupon,
				productId,
				now,
			}) ||
			isShareableEvergreenCoupon(
				requestedMerchantCoupon,
				requestedSiteCoupon,
				productId,
				quantity,
				now,
			)
		: false
	const protectedMerchantCoupon = Boolean(
		requestedMerchantCouponId && !publicProvenance,
	)

	if (
		requestedMerchantCoupon?.type === 'ppp' &&
		requestedMerchantCoupon.status === 1
	) {
		return {
			authorized: false,
			protectedMerchantCoupon,
			protectedSiteCoupon,
			requestedPPP: true,
		}
	}

	if (!requestedMerchantCouponId) {
		if (!requestedSiteCoupon) {
			return {
				authorized: true,
				protectedMerchantCoupon,
				protectedSiteCoupon,
			}
		}
		if (!protectedSiteCoupon) {
			return {
				authorized: publicProvenance,
				protectedMerchantCoupon,
				protectedSiteCoupon,
			}
		}
	}

	if (publicProvenance) {
		return {
			authorized: true,
			protectedMerchantCoupon,
			protectedSiteCoupon,
		}
	}

	if (
		(requestedMerchantCouponId && requestedMerchantCoupon?.status !== 1) ||
		!verifiedUserId ||
		quantity !== 1
	) {
		return {
			authorized: false,
			protectedMerchantCoupon,
			protectedSiteCoupon,
		}
	}

	const entitlement = await findEntitlementCoupon({
		adapter,
		getCoupon,
		verifiedUserId,
		productId,
		quantity,
		now,
		merchantCouponId: requestedMerchantCouponId,
		siteCouponId: protectedSiteCoupon ? requestedSiteCoupon?.id : undefined,
	})
	return {
		authorized: Boolean(entitlement),
		protectedMerchantCoupon,
		protectedSiteCoupon,
		...(entitlement && { entitlementCouponId: entitlement.id }),
	}
}

async function findEntitlementCoupon({
	adapter,
	getCoupon,
	verifiedUserId,
	productId,
	quantity,
	now,
	merchantCouponId,
	siteCouponId,
}: Pick<
	AuthorizeExclusiveCouponSelectionInput,
	'adapter' | 'verifiedUserId' | 'productId' | 'quantity'
> & {
	getCoupon: ExclusiveCouponAuthorizationAdapter['getCoupon']
	now: Date
	merchantCouponId?: string | null
	siteCouponId?: string
}) {
	if (!verifiedUserId || quantity !== 1) return null
	const entitlementType = await adapter.getEntitlementTypeByName(
		'apply_special_credit',
	)
	if (!entitlementType) return null

	const entitlements = await adapter.getEntitlementsForUser({
		userId: verifiedUserId,
		sourceType: 'COUPON',
		entitlementType: entitlementType.id,
	})

	for (const entitlement of entitlements) {
		if (
			!isActiveEntitlement(entitlement, verifiedUserId, entitlementType.id, now)
		) {
			continue
		}

		const sourceCoupon = await getCoupon(entitlement.sourceId)
		if (
			!sourceCoupon?.merchantCouponId ||
			!couponIsActive(sourceCoupon, now) ||
			!couponPermitsProduct(sourceCoupon, productId)
		) {
			continue
		}
		if (merchantCouponId && sourceCoupon.merchantCouponId !== merchantCouponId)
			continue
		if (siteCouponId && sourceCoupon.id !== siteCouponId) continue
		return {
			id: sourceCoupon.id,
			merchantCouponId: sourceCoupon.merchantCouponId,
		}
	}
	return null
}
