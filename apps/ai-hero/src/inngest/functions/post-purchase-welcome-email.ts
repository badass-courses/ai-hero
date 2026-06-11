import config from '@/config'
import WelcomeCohortEmail from '@/emails/welcome-cohort-email'
import WelcomeWorkshopEmail from '@/emails/welcome-workshop-email'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { ContentResourceSchema } from '@coursebuilder/core/schemas'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT } from '../events/post-purchase-async'
import { inngest } from '../inngest.server'

const generateContentUrl = (
	resource: any,
	productType: string,
	workshopAvailability?: { availableNow: any[]; upcoming: any[] } | null,
) => {
	if (productType === 'cohort') {
		return `${process.env.NEXT_PUBLIC_URL}${getResourcePath('cohort', resource.fields?.slug || '', 'view')}`
	}

	const firstAvailableWorkshop = workshopAvailability?.availableNow[0]
	if (firstAvailableWorkshop) {
		const workshop = firstAvailableWorkshop as { fields?: { slug?: string } }
		return `${process.env.NEXT_PUBLIC_URL}${getResourcePath('workshop', workshop.fields?.slug || '', 'view')}`
	}

	return `${process.env.NEXT_PUBLIC_URL}${getResourcePath('workshop', resource.fields?.slug || '', 'view')}`
}

export const postPurchaseWelcomeEmail = inngest.createFunction(
	{
		id: 'post-purchase-welcome-email',
		name: 'Post Purchase Welcome Email',
		idempotency: 'event.data.purchaseId + "-" + event.data.resourceId',
		concurrency: {
			limit: 5,
		},
	},
	{ event: POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT },
	async ({ event, step }) => {
		const {
			purchaseId,
			userId,
			userEmail,
			userFirstName,
			resourceId,
			resourceType,
			resourceProductType,
			resourceData,
			workshopAvailability,
		} = event.data

		await step.run(`send welcome email for ${resourceId}`, async () => {
			const parsedResource = ContentResourceSchema.parse(resourceData)
			const contentUrl = generateContentUrl(
				parsedResource,
				resourceProductType,
				workshopAvailability,
			)

			if (resourceProductType === 'cohort') {
				await sendAnEmail({
					Component: WelcomeCohortEmail,
					componentProps: {
						cohortTitle:
							parsedResource.fields?.title || parsedResource.fields?.slug,
						url: contentUrl,
						availableNow: workshopAvailability?.availableNow || [],
						upcoming: workshopAvailability?.upcoming || [],
						userFirstName,
					},
					Subject: `Welcome to ${parsedResource.fields?.title || config.defaultTitle}!`,
					To: userEmail,
					ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
					From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
					type: 'transactional',
				})
			} else {
				await sendAnEmail({
					Component: WelcomeWorkshopEmail,
					componentProps: {
						workshopTitle:
							parsedResource.fields?.title || parsedResource.fields?.slug,
						url: contentUrl,
						userFirstName,
					},
					Subject: `Welcome to ${parsedResource.fields?.title || config.defaultTitle}!`,
					To: userEmail,
					ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
					From: env.NEXT_PUBLIC_SUPPORT_EMAIL,
					type: 'transactional',
				})
			}

			await log.info('post_purchase_welcome_email.sent', {
				purchaseId,
				userId,
				resourceId,
				resourceType,
				resourceProductType,
			})
		})

		return { status: 'completed' }
	},
)
