type ArchiveEntitlementLike = {
	id: string
	entitlementType: string
	sourceId: string
	metadata?: Record<string, any> | null
	expiresAt?: Date | null
}

const ARCHIVE_DERIVED_METADATA_KEYS = [
	'archiveProductId',
	'archivePurchaseId',
	'archiveCohortId',
	'archiveSource',
	'availableAfterDays',
	'accessDurationDays',
] as const

export const isArchiveProductType = (productType?: string | null) => {
	return productType === 'cohort-archive'
}

export const isArchiveDerivedEntitlement = (
	entitlement: Pick<
		ArchiveEntitlementLike,
		'entitlementType' | 'sourceId' | 'metadata'
	>,
	options?: {
		purchaseId?: string
		productId?: string
	},
) => {
	const metadata = entitlement.metadata ?? {}
	const metadataHasArchiveSignal = ARCHIVE_DERIVED_METADATA_KEYS.some((key) => {
		return metadata[key] !== undefined && metadata[key] !== null
	})

	const matchesPurchase = options?.purchaseId
		? entitlement.sourceId === options.purchaseId ||
			metadata.archivePurchaseId === options.purchaseId
		: true

	const matchesProduct = options?.productId
		? metadata.archiveProductId === options.productId ||
			metadata.productId === options.productId ||
			metadata.sourceProductId === options.productId
		: true

	return (
		entitlement.entitlementType === 'cohort_content_access' &&
		metadataHasArchiveSignal &&
		matchesPurchase &&
		matchesProduct
	)
}

export const getArchiveEntitlementResourceId = (
	entitlement: Pick<ArchiveEntitlementLike, 'id' | 'metadata'>,
) => {
	const metadata = entitlement.metadata ?? {}

	return (
		metadata.archiveCohortId ||
		metadata.cohortId ||
		metadata.contentIds?.[0] ||
		entitlement.id
	)
}

export const getArchiveEntitlementTitle = (
	entitlement: Pick<ArchiveEntitlementLike, 'metadata'>,
) => {
	const metadata = entitlement.metadata ?? {}

	return (
		metadata.archiveCohortTitle ||
		metadata.cohortTitle ||
		metadata.resourceTitle ||
		metadata.contentTitle ||
		'Archive cohort access'
	)
}

export const summarizeArchiveEntitlements = (
	entitlements: Array<
		Pick<ArchiveEntitlementLike, 'id' | 'metadata' | 'expiresAt'>
	>,
) => {
	const modules = new Map<
		string,
		{ id: string; title: string; accessible: true }
	>()
	let expiresAt: string | undefined

	for (const entitlement of entitlements) {
		const moduleId = getArchiveEntitlementResourceId(entitlement)
		if (!modules.has(moduleId)) {
			modules.set(moduleId, {
				id: moduleId,
				title: getArchiveEntitlementTitle(entitlement),
				accessible: true,
			})
		}

		if (!expiresAt && entitlement.expiresAt) {
			expiresAt = entitlement.expiresAt.toISOString()
		}
	}

	return {
		modules: Array.from(modules.values()),
		expiresAt,
	}
}
