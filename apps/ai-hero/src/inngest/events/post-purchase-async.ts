import type { ProductType } from '../config/product-types'

export const POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT =
	'post-purchase/discord-role.requested'

export type PostPurchaseDiscordRoleRequested = {
	name: typeof POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT
	data: {
		purchaseId: string
		userId: string
		organizationId: string
		organizationMembershipId: string
		resourceId: string
		resourceType: string
		resourceProductType: ProductType
		resourceDataId: string
		discordRoleId: string | null
		discordRoleEntitlementTypeId: string | null
	}
}

export const POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT =
	'post-purchase/welcome-email.requested'

export type PostPurchaseWelcomeEmailRequested = {
	name: typeof POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT
	data: {
		purchaseId: string
		userId: string
		userEmail: string
		userFirstName?: string
		resourceId: string
		resourceType: string
		resourceProductType: ProductType
		resourceData: Record<string, unknown>
		workshopAvailability?: {
			availableNow: Array<any>
			upcoming: Array<any>
		} | null
	}
}
