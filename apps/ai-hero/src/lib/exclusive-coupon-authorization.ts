type Awaitable<T> = T | Promise<T>

type MerchantCouponRecord = {
	id: string
	type?: string | null
}

type SiteCouponRecord = {
	id: string
	merchantCouponId?: string | null
	restrictedToProductId?: string | null
	fields?: Record<string, unknown> | null
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

/**
 * A MerchantCoupon id selects provider discount data. It does not prove that
 * the caller owns an exclusive credit. Keep this app-local until AI Hero can
 * consume the equivalent policy from Course Builder without a launch migration.
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
	const [requestedMerchantCoupon, requestedSiteCoupon] = await Promise.all([
		requestedMerchantCouponId
			? adapter.getMerchantCoupon(requestedMerchantCouponId)
			: null,
		requestedSiteCouponId ? adapter.getCoupon(requestedSiteCouponId) : null,
	])

	const protectedMerchantCoupon =
		requestedMerchantCoupon?.type === 'special credit'
	const protectedSiteCoupon = requestedSiteCoupon?.fields?.exclusive === true

	if (!protectedMerchantCoupon && !protectedSiteCoupon) {
		return {
			authorized: true,
			protectedMerchantCoupon,
			protectedSiteCoupon,
		}
	}

	if (!verifiedUserId || quantity !== 1) {
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
		if (!sourceCoupon?.merchantCouponId) continue
		if (
			sourceCoupon.restrictedToProductId &&
			sourceCoupon.restrictedToProductId !== productId
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
