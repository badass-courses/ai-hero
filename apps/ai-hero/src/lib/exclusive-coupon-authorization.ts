type Awaitable<T> = T | Promise<T>

type MerchantCouponRecord = {
	id: string
	type?: string | null
	status?: number
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
	entitlementCouponId?: string
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
	const requestedSiteCoupon = requestedSiteCouponId
		? await adapter.getCoupon(requestedSiteCouponId)
		: null
	const merchantCouponId =
		requestedMerchantCouponId || requestedSiteCoupon?.merchantCouponId
	const requestedMerchantCoupon = merchantCouponId
		? await adapter.getMerchantCoupon(merchantCouponId)
		: null

	const protectedSiteCoupon = requestedSiteCoupon?.fields?.exclusive === true
	const publicProvenance = requestedMerchantCoupon
		? isPublicCouponProvenance({
				merchantCoupon: requestedMerchantCoupon,
				siteCoupon: requestedSiteCoupon,
				productId,
				now,
			})
		: false
	const protectedMerchantCoupon = Boolean(
		requestedMerchantCouponId && !publicProvenance,
	)

	if (requestedMerchantCoupon?.type === 'ppp') {
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

	const entitlementType = await adapter.getEntitlementTypeByName(
		'apply_special_credit',
	)
	if (!entitlementType) {
		return {
			authorized: false,
			protectedMerchantCoupon,
			protectedSiteCoupon,
		}
	}

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

		const sourceCoupon = await adapter.getCoupon(entitlement.sourceId)
		if (
			!sourceCoupon?.merchantCouponId ||
			!couponIsActive(sourceCoupon, now) ||
			!couponPermitsProduct(sourceCoupon, productId)
		) {
			continue
		}
		if (
			requestedMerchantCouponId &&
			sourceCoupon.merchantCouponId !== requestedMerchantCouponId
		) {
			continue
		}
		if (protectedSiteCoupon && sourceCoupon.id !== requestedSiteCoupon?.id) {
			continue
		}

		return {
			authorized: true,
			protectedMerchantCoupon,
			protectedSiteCoupon,
			entitlementCouponId: sourceCoupon.id,
		}
	}

	return {
		authorized: false,
		protectedMerchantCoupon,
		protectedSiteCoupon,
	}
}
