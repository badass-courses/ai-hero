import { WorkshopBatchAccessEmail } from '@/emails/workshop-batch-access-email'
import { inngest } from '@/inngest/inngest.server'
import {
	getCohortProducts,
	getUserWorkshopEntitlements,
	getWorkshopsStartingToday,
} from '@/lib/cohort-workshop-emails-query'
import { getAllWorkshopsInCohort } from '@/lib/cohorts-query'
import { groupWorkshopsByStartTime } from '@/lib/group-workshops-by-start-time'
import type { Workshop } from '@/lib/workshops'
import { getWorkshop } from '@/lib/workshops-query'
import { log } from '@/server/logger'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'

export const sendWorkshopAccessEmails = inngest.createFunction(
	{
		id: 'send-workshop-access-emails',
		name: 'Schedule Workshop Access Emails',
	},
	{ cron: '30 0 * * *' }, // Run at 0:30 UTC
	async ({ event, step }) => {
		const startTime = Date.now()
		let totalEmailsSent = 0
		let totalWorkshopsScheduled = 0
		const errors: string[] = []

		// 1. Get all cohort products
		const cohortProducts = await step.run('get-cohort-products', async () => {
			try {
				return await getCohortProducts()
			} catch (error) {
				await log.error('Failed to get cohort products', { error })
				throw error
			}
		})

		await log.info('Workshop access emails scheduling started', {
			cohortProductsFound: cohortProducts.length,
		})

		// 2. Collect all workshops starting today from all cohort products
		const workshopsStartingToday = await step.run(
			'get-workshops-starting-today',
			async () => {
				const allWorkshopsStartingToday: Workshop[] = []

				await log.info('Starting to process cohort products', {
					totalProducts: cohortProducts.length,
				})

				for (const [index, product] of cohortProducts.entries()) {
					try {
						await log.info('Processing cohort product', {
							productIndex: index,
							productId: product.id,
							totalProducts: cohortProducts.length,
						})

						// Get cohort from product resources
						const cohortResource = product.resources?.find(
							(r) => r.resource?.type === 'cohort',
						)
						if (!cohortResource) {
							await log.info('No cohort resource found, skipping', {
								productId: product.id,
							})
							continue
						}

						await log.info('Found cohort resource, getting workshops', {
							productId: product.id,
							cohortId: cohortResource.resource.id,
						})

						// Get workshops in cohort
						const workshops = await getAllWorkshopsInCohort(
							cohortResource.resource.id,
						)

						await log.info('Got workshops from cohort, filtering for today', {
							productId: product.id,
							cohortId: cohortResource.resource.id,
							totalWorkshops: workshops.length,
						})

						// Filter workshops starting today using UTC-consistent function
						const startingToday = await getWorkshopsStartingToday(workshops)

						await log.info('Filtered workshops starting today', {
							productId: product.id,
							cohortId: cohortResource.resource.id,
							totalWorkshops: workshops.length,
							workshopsStartingToday: startingToday.length,
						})

						allWorkshopsStartingToday.push(...startingToday)

						await log.info('Cohort workshops processed successfully', {
							productId: product.id,
							totalWorkshops: workshops.length,
							workshopsStartingToday: startingToday.length,
							totalCollectedSoFar: allWorkshopsStartingToday.length,
						})
					} catch (error) {
						const errorMsg = `Failed to process cohort product ${product.id}: ${error}`
						errors.push(errorMsg)
						await log.error(errorMsg, { productId: product.id, error })
					}
				}

				await log.info('Completed processing all cohort products', {
					totalWorkshopsStartingToday: allWorkshopsStartingToday.length,
				})

				return allWorkshopsStartingToday
			},
		)

		await log.info('Workshops starting today found', {
			totalStartingToday: workshopsStartingToday.length,
		})

		// 3. Group workshops by start time and process each batch
		// Pure logic — no I/O, no need for an Inngest step checkpoint
		const groups = groupWorkshopsByStartTime(
			workshopsStartingToday as Workshop[],
		)
		const workshopGroups = Array.from(groups.entries()).map(
			([time, workshops]) => ({
				startTime: time,
				workshopIds: workshops.map((w) => w.id),
			}),
		)

		await log.info('Workshops grouped by start time', {
			groupCount: workshopGroups.length,
			groups: workshopGroups.map((g) => ({
				startTime: g.startTime,
				workshopCount: g.workshopIds.length,
			})),
		})

		for (const group of workshopGroups) {
			// Validate the group's start time
			const groupPrep = await step.run(
				`prep-group-${group.startTime}`,
				async () => {
					const groupStartTime = new Date(group.startTime)
					const now = new Date()

					if (groupStartTime <= now) {
						return { skipped: 'start time already passed' }
					}

					await log.info('Preparing workshop group for scheduling', {
						startTime: group.startTime,
						workshopCount: group.workshopIds.length,
					})

					return { ready: true, startTime: group.startTime }
				},
			)

			if ('skipped' in groupPrep) {
				continue
			}

			// Sleep once for the entire group
			await step.sleepUntil(
				`wait-for-group-start-${group.startTime}`,
				groupPrep.startTime,
			)

			// Send batch email for all workshops in this group
			const groupResult = await step.run(
				`send-batch-emails-${group.startTime}`,
				async () => {
					try {
						// Resolve which workshops in this batch each user is
						// entitled to — users must only be emailed their own.
						const entitledUsers = await getUserWorkshopEntitlements(
							group.workshopIds,
						)

						if (entitledUsers.length === 0) {
							return { skipped: 'no entitled users found' }
						}

						// Get full workshop details for each workshop in the group
						const fullWorkshops = await Promise.all(
							group.workshopIds.map((id) => getWorkshop(id)),
						)
						const validWorkshops = fullWorkshops.filter(
							(w): w is Workshop => w !== null && w !== undefined,
						)

						if (validWorkshops.length === 0) {
							return { skipped: 'no valid workshops found' }
						}

						let emailsSent = 0

						// Send one batch email per user — each user only
						// receives the workshops they are entitled to.
						for (const {
							user,
							workshopIds: userWorkshopIds,
						} of entitledUsers) {
							// Narrow the batch to this user's entitled workshops.
							const userWorkshops = validWorkshops.filter((w) =>
								userWorkshopIds.includes(w.id),
							)

							// Skip users whose entitled workshops aren't in this
							// batch (e.g. workshop details failed to load).
							if (userWorkshops.length === 0) {
								continue
							}

							try {
								const subject =
									userWorkshops.length === 1
										? `Your access to ${userWorkshops[0]!.fields.title} opens today`
										: `${userWorkshops.length} new workshops are now available`

								await sendAnEmail({
									Component: WorkshopBatchAccessEmail,
									componentProps: {
										user: {
											name: user.name || undefined,
											email: user.email,
										},
										workshops: userWorkshops.map((w) => ({
											fields: {
												title: w.fields.title,
												description: w.fields.description || undefined,
												slug: w.fields.slug || undefined,
											},
										})),
									},
									To: user.email,
									Subject: subject,
									From: `${process.env.NEXT_PUBLIC_SITE_TITLE} <${process.env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
								})

								emailsSent++
							} catch (error) {
								const workshopTitles = userWorkshops
									.map((w) => w.fields.title)
									.join(', ')
								const errorMsg = `Failed to send batch email to ${user.email} for workshops: ${workshopTitles}`
								errors.push(errorMsg)
								await log.error(errorMsg, {
									userId: user.id,
									workshopIds: userWorkshopIds,
									error,
								})
							}
						}

						await log.info('Batch workshop emails processed', {
							startTime: group.startTime,
							workshopCount: validWorkshops.length,
							workshopTitles: validWorkshops.map((w) => w.fields.title),
							entitledUsers: entitledUsers.length,
							emailsSent,
						})

						return {
							processed: true,
							emailsSent,
							entitledUsers: entitledUsers.length,
							workshopCount: validWorkshops.length,
							sentAt: new Date().toISOString(),
						}
					} catch (error) {
						const errorMsg = `Failed to send batch emails for group ${group.startTime}: ${error}`
						errors.push(errorMsg)
						await log.error(errorMsg, {
							startTime: group.startTime,
							workshopIds: group.workshopIds,
							error,
						})
						return { error: errorMsg }
					}
				},
			)

			// Track results
			if ('emailsSent' in groupResult && groupResult.emailsSent) {
				totalEmailsSent += groupResult.emailsSent
			}
			if ('processed' in groupResult && groupResult.processed) {
				totalWorkshopsScheduled += group.workshopIds.length
			}
		}

		// 4. Log final summary
		return await step.run('log-summary', async () => {
			const endTime = Date.now()
			const summary = {
				totalProductsProcessed: cohortProducts.length,
				totalWorkshopsStartingToday: workshopsStartingToday.length,
				totalWorkshopsScheduled,
				totalEmailsSent,
				errors,
				processingTime: endTime - startTime,
			}

			await log.info('Workshop access emails scheduling completed', summary)
			return summary
		})
	},
)
