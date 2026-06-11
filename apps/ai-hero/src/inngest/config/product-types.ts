import { env } from '@/env.mjs'
import { getAllWorkshopsInCohort, getCohort } from '@/lib/cohorts-query'
import {
	createCohortEntitlement,
	createWorkshopEntitlement,
} from '@/lib/entitlements'
import {
	getWorkshopAvailability,
	type WorkshopAvailability,
} from '@/lib/get-workshop-availability'
import { getWorkshop } from '@/lib/workshops-query'
import { formatInTimeZone } from 'date-fns-tz'

import type { ContentResource, Product } from '@coursebuilder/core/schemas'

import {
	USER_ADDED_TO_COHORT_EVENT,
	USER_ADDED_TO_WORKSHOP_EVENT,
} from '../functions/discord/add-discord-role-workflow'

/**
 * Shared product type configuration used across all workflows
 * This eliminates duplication between post-purchase, transfer, and other workflows
 */
export const PRODUCT_TYPE_CONFIG = {
	cohort: {
		resourceType: 'cohort',
		queryFn: getCohort,
		contentAccess: 'cohort_content_access',
		discordRole: 'cohort_discord_role',
		createEntitlement: createCohortEntitlement,
		discordEvent: USER_ADDED_TO_COHORT_EVENT,
		logPrefix: 'cohort',
		getDiscordRoleId: (product: any) =>
			product?.fields?.discordRoleId || env.DISCORD_COHORT_001_ROLE_ID,
	},
	'self-paced': {
		resourceType: 'workshop',
		queryFn: getWorkshop,
		contentAccess: 'workshop_content_access',
		discordRole: 'workshop_discord_role',
		createEntitlement: createWorkshopEntitlement,
		discordEvent: USER_ADDED_TO_WORKSHOP_EVENT,
		logPrefix: 'workshop',
		getDiscordRoleId: (product: any) =>
			product?.fields?.discordRoleId || env.DISCORD_PURCHASER_ROLE_ID,
	},
	// Future product types can be added here
	// live: { ... },
	// membership: { ... },
} as const

// Entitlement config for backwards compatibility
export const ENTITLEMENT_CONFIG = {
	cohort: {
		contentAccess: PRODUCT_TYPE_CONFIG.cohort.contentAccess,
		discordRole: PRODUCT_TYPE_CONFIG.cohort.discordRole,
		createEntitlement: PRODUCT_TYPE_CONFIG.cohort.createEntitlement,
		discordEvent: PRODUCT_TYPE_CONFIG.cohort.discordEvent,
		logPrefix: PRODUCT_TYPE_CONFIG.cohort.logPrefix,
	},
	'self-paced': {
		contentAccess: PRODUCT_TYPE_CONFIG['self-paced'].contentAccess,
		discordRole: PRODUCT_TYPE_CONFIG['self-paced'].discordRole,
		createEntitlement: PRODUCT_TYPE_CONFIG['self-paced'].createEntitlement,
		discordEvent: PRODUCT_TYPE_CONFIG['self-paced'].discordEvent,
		logPrefix: PRODUCT_TYPE_CONFIG['self-paced'].logPrefix,
	},
} as const

export type ProductType = keyof typeof PRODUCT_TYPE_CONFIG

const RESOURCE_TYPE_TO_PRODUCT_TYPE: Partial<Record<string, ProductType>> = {
	cohort: 'cohort',
	workshop: 'self-paced',
}

/**
 * Resolve the product type that should be used for a given resource type.
 *
 * @param resourceType - The content resource type (e.g. `cohort`, `workshop`)
 * @returns The matching product type when supported, otherwise null
 */
export const resolveProductTypeForResource = (
	resourceType?: string | null,
): ProductType | null => {
	if (!resourceType) return null
	return RESOURCE_TYPE_TO_PRODUCT_TYPE[resourceType] ?? null
}

/**
 * Retrieve the first product associated with a content resource.
 *
 * @param resource - The content resource containing optional `resourceProducts`
 * @returns The first related product if present, otherwise null
 */
export const getProductForResource = (
	resource: Pick<ContentResource, 'resourceProducts'>,
): Product | null => {
	const resourceProduct = resource.resourceProducts?.find((productJoin) =>
		Boolean(productJoin.product),
	)

	return (resourceProduct?.product as Product) ?? null
}

/**
 * Get resource data based on product type
 */
export const getResourceData = async (
	resourceId: string,
	productType: ProductType,
) => {
	const config = PRODUCT_TYPE_CONFIG[productType]
	if (!config) {
		throw new Error(`Unsupported product type: ${productType}`)
	}
	return await config.queryFn(resourceId)
}

/**
 * Get Discord role ID for a product type with fallback
 */
export const getDiscordRoleId = (productType: ProductType, product: any) => {
	const config = PRODUCT_TYPE_CONFIG[productType]
	return config.getDiscordRoleId(product)
}

/**
 * Resource context for processing in workflows
 */
export type ResourceContext = {
	resourceId: string
	resourceType: string
	productType: ProductType
	productForResource: Product | null
	workshopAvailability?: WorkshopAvailability | null
	/** @deprecated Use workshopAvailability instead */
	dayOneUnlockDate?: string | null
}

/**
 * Gather all resource contexts from a product.
 * Each resource gets its own product type based on its resource type or its own product.
 *
 * @param product - The product containing resources
 * @param purchasedProductType - The product type of the purchased product
 * @returns Array of resource contexts to process
 */
export const gatherResourceContexts = async (
	product: any,
	purchasedProductType: ProductType,
): Promise<ResourceContext[]> => {
	const contexts: ResourceContext[] = []

	if (!product.resources || product.resources.length === 0) {
		return contexts
	}

	for (const resourceItem of product.resources) {
		if (!resourceItem.resource) continue

		const resource = resourceItem.resource
		const resourceType = resource.type

		// Try to get the resource's own product first
		const productForResource = getProductForResource(resource)
		const resourceProductType = productForResource?.type
			? (productForResource.type as ProductType)
			: resolveProductTypeForResource(resourceType)

		// If we can't determine product type, skip this resource
		if (!resourceProductType) {
			continue
		}

		// Calculate workshop availability for cohort resources
		let workshopAvailability: WorkshopAvailability | null = null
		let dayOneUnlockDate: string | null = null
		if (resourceProductType === 'cohort') {
			// Fetch full workshop data — resource.resources only has join records
			// getAllWorkshopsInCohort returns ordered by position, so index matches
			const workshops = await getAllWorkshopsInCohort(resource.id)
			const workshopResources = workshops.map((w, i) => ({
				resource: { fields: w.fields },
				position: i,
			}))
			workshopAvailability = getWorkshopAvailability(workshopResources)

			// Keep dayOneUnlockDate for backward compat
			const firstDated = workshops.find((w) => w.fields.startsAt)
			if (firstDated?.fields.startsAt) {
				dayOneUnlockDate = formatInTimeZone(
					new Date(firstDated.fields.startsAt),
					'America/Los_Angeles',
					'MMMM do, yyyy',
				)
			} else {
				dayOneUnlockDate = 'TBD'
			}
		}

		contexts.push({
			resourceId: resource.id,
			resourceType,
			productType: resourceProductType,
			productForResource: productForResource || null,
			workshopAvailability,
			dayOneUnlockDate,
		})
	}

	return contexts
}
