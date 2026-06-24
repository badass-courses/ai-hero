import { inngest } from '@/inngest/inngest.server'
import { getEventOrEventSeries } from '@/lib/events-query'
import { addUserToGoogleCalendarEvent } from '@/lib/google-calendar'
import { log } from '@/server/logger'

import { FULL_PRICE_COUPON_REDEEMED_EVENT } from '@coursebuilder/core/inngest/commerce/event-full-price-coupon-redeemed'
import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'
import type { Product } from '@coursebuilder/core/schemas'

type ProductResourceReference = {
	resource?: {
		id?: string
		type?: string | null
	} | null
}

/**
 * Post-event purchase workflow that adds purchasers to Google Calendar events.
 *
 * Triggered when someone purchases a "live" product type. Automatically adds
 * the user as an attendee to the associated Google Calendar event(s).
 *
 * Handles both single events and event-series (multiple child events).
 */
export const postEventPurchase = inngest.createFunction(
	{
		id: `post-event-purchase-calendar-sync`,
		name: `Add to Google Calendar Event`,
		idempotency: 'event.data.purchaseId',
	},
	[
		{
			event: NEW_PURCHASE_CREATED_EVENT,
			if: 'event.data.productType == "live"',
		},
		{
			event: FULL_PRICE_COUPON_REDEEMED_EVENT,
			if: 'event.data.productType == "live"',
		},
	],
	async ({ event, step, db: adapter }) => {
		const purchase = await step.run(`get purchase`, async () => {
			return adapter.getPurchase(event.data.purchaseId)
		})

		if (!purchase) {
			throw new Error(`purchase not found`)
		}

		const product = await step.run(`get product`, async () => {
			return adapter.getProduct(purchase.productId as string)
		})

		if (!product) {
			throw new Error(`product not found`)
		}

		const user = await step.run(`get user`, async () => {
			return adapter.getUserById(purchase.userId as string)
		})

		if (!user) {
			throw new Error(`user not found`)
		}

		// Note: Shortlink attribution is handled by the dedicated shortlink-attribution
		// inngest function which runs for ALL purchase types

		const isTeamPurchase = Boolean(purchase.bulkCouponId)

		// Find the event or event-series associated with this product
		const productWithResources = product as Product & {
			resources?: ProductResourceReference[]
		}
		const eventResourceId = productWithResources.resources?.find((resource) =>
			['event', 'event-series'].includes(resource.resource?.type ?? ''),
		)?.resource?.id

		const eventResource = await step.run(`get event resource`, async () => {
			await log.debug('purchase.post-event.resource.lookup.started', {
				purchaseId: purchase.id,
				userId: user.id,
				eventResourceId: eventResourceId ?? null,
				isTeamPurchase,
				resourceType: null,
			})
			const resource = await getEventOrEventSeries(eventResourceId)
			await log.info('purchase.post-event.resource.lookup.completed', {
				purchaseId: purchase.id,
				userId: user.id,
				eventResourceId: eventResourceId ?? null,
				isTeamPurchase,
				resourceType: resource?.type ?? null,
			})
			return resource
		})

		let gCalEvent = null

		if (isTeamPurchase) {
			// Team purchases: the purchaser manages seat distribution
			// Individual team members will get calendar invites when they claim seats
			await log.info('purchase.post-event.team-purchase.skipped', {
				purchaseId: purchase.id,
				userId: user.id,
				eventResourceId: eventResourceId ?? null,
				isTeamPurchase,
				resourceType: eventResource?.type ?? null,
			})
		} else {
			if (['Valid', 'Restricted'].includes(purchase.status)) {
				// Add user to organization if applicable
				const orgMembership = await step.run(`get org membership`, async () => {
					if (!purchase.organizationId) {
						await log.info('purchase.post-event.org-membership.skipped', {
							purchaseId: purchase.id,
							userId: user.id,
							eventResourceId: eventResourceId ?? null,
							isTeamPurchase,
							resourceType: eventResource?.type ?? null,
						})
						return null
					}
					const orgMembership = await adapter.addMemberToOrganization({
						organizationId: purchase.organizationId,
						userId: user.id,
						invitedById: purchase.userId || user.id,
					})

					if (!orgMembership) {
						throw new Error(`orgMembership is required`)
					}

					await adapter.addRoleForMember({
						organizationId: purchase.organizationId,
						memberId: orgMembership.id,
						role: 'learner',
					})

					return orgMembership
				})

				// Handle event series (multiple child events)
				if (
					eventResource?.type === 'event-series' &&
					eventResource.resources &&
					eventResource.resources.length > 0
				) {
					const calendarResults = []
					for (const { resource } of eventResource.resources) {
						if (resource?.type === 'event' && resource.fields.calendarId) {
							const calResult = await step.run(
								`add user to calendar event (${resource.fields.title})`,
								async () => {
									if (!user.email) {
										throw new Error(`user.email is required`)
									}
									if (!resource.fields.calendarId) {
										throw new Error(`resource.fields.calendarId is required`)
									}
									return await addUserToGoogleCalendarEvent(
										resource.fields.calendarId,
										user.email,
									)
								},
							)
							calendarResults.push(calResult)
						}
					}
					gCalEvent = calendarResults
				} else {
					// Handle single event
					if (
						eventResource?.type === 'event' &&
						'calendarId' in eventResource.fields &&
						eventResource.fields.calendarId
					) {
						gCalEvent = await step.run(
							`add user to calendar event`,
							async () => {
								if (!user.email) {
									throw new Error(`user.email is required`)
								}
								if (
									!('calendarId' in eventResource.fields) ||
									!eventResource.fields.calendarId
								) {
									throw new Error(`eventResource.fields.calendarId is required`)
								}
								return await addUserToGoogleCalendarEvent(
									eventResource.fields.calendarId as string,
									user.email,
								)
							},
						)
					}
				}
			} else {
				await log.info('purchase.post-event.calendar.skipped', {
					purchaseId: purchase.id,
					userId: user.id,
					eventResourceId: eventResourceId ?? null,
					isTeamPurchase,
					resourceType: eventResource?.type ?? null,
					purchaseStatus: purchase.status,
				})
			}
		}

		return {
			purchase,
			product,
			user,
			eventResource,
			isTeamPurchase,
			gCalEvent,
		}
	},
)
