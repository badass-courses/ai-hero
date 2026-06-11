import BasicEmail from '@/emails/basic-email'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import {
	getCohortReminderRecipients,
	getCohortRemindersNeedingScheduling,
	type CohortReminderData,
} from '@/lib/cohort-email-reminders-query'
import { getAllWorkshopsInCohort } from '@/lib/cohorts-query'
import { type Email } from '@/lib/emails'
import { log } from '@/server/logger'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { Liquid } from 'liquidjs'

const SEND_TO_SUPPORT_EMAIL_ENABLED = true

export const cohortReminderBroadcast = inngest.createFunction(
	{
		id: 'cohort-reminder-broadcast',
		name: 'Cohort Reminder Broadcast',
	},
	{
		cron: 'TZ=America/Los_Angeles 0 6 * * *',
	},
	async ({ step }) => {
		const now = new Date()
		const today = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
		)
		const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)

		const remindersToSchedule = await step.run(
			'get-cohort-reminders-to-schedule',
			async () => {
				return await getCohortRemindersNeedingScheduling(now, tomorrow)
			},
		)

		if (remindersToSchedule.length === 0) {
			return { scheduled: 0, sent: 0, reminders: [] }
		}

		const results = []

		for (const reminderData of remindersToSchedule) {
			await step.sleepUntil(
				`wait-for-cohort-reminder-${reminderData.cohort.id}-${reminderData.emailResource.id}`,
				reminderData.reminderTime,
			)

			const result = await step.run(
				`send-cohort-reminder-${reminderData.cohort.id}-${reminderData.emailResource.id}`,
				async () => {
					return await sendCohortReminder(reminderData as CohortReminderData)
				},
			)

			results.push(result)
		}

		const totalSent = results.reduce(
			(sum, result) => sum + (result.sent || 0),
			0,
		)
		const errors = results
			.filter((result) => result.error)
			.map((result) => result.error)

		return {
			scheduled: remindersToSchedule.length,
			sent: totalSent,
			reminders: results,
			errors,
		}
	},
)

async function sendCohortReminder(reminderData: CohortReminderData) {
	try {
		const { cohort, emailResource } = reminderData

		let recipients = await getCohortReminderRecipients(cohort.id)
		const workshops = await getAllWorkshopsInCohort(cohort.id)
		const url = `${env.NEXT_PUBLIC_URL}/cohorts/${cohort.fields.slug}`

		if (recipients.length === 0) {
			return {
				cohortId: cohort.id,
				emailId: emailResource.id,
				sent: 0,
				error: null,
			}
		}

		if (SEND_TO_SUPPORT_EMAIL_ENABLED) {
			recipients.push({
				id: 'support',
				email: env.NEXT_PUBLIC_SUPPORT_EMAIL,
				name: 'team',
			})
		}

		const liquid = new Liquid()
		const emailResourceTyped = emailResource as Email
		const emailBody =
			emailResourceTyped?.fields?.body ||
			'Your cohort starts soon. Please check your dashboard.'
		const emailSubject =
			emailResourceTyped?.fields?.subject ||
			`${cohort.fields.title} starts soon`

		let sentCount = 0
		const errors: string[] = []

		for (const recipient of recipients) {
			try {
				let parsedBody: string
				let parsedSubject: string

				try {
					parsedBody = await liquid.parseAndRender(emailBody, {
						cohort,
						workshops,
						title: cohort.fields.title,
						url,
						user: recipient,
					})
					parsedSubject = await liquid.parseAndRender(emailSubject, {
						cohort,
						workshops,
						title: cohort.fields.title,
						url,
						user: recipient,
					})
				} catch (templateError) {
					throw new Error(
						`Template parsing failed: ${templateError instanceof Error ? templateError.message : String(templateError)}`,
					)
				}

				await sendAnEmail({
					Component: BasicEmail,
					componentProps: {
						body: parsedBody,
					},
					Subject: parsedSubject,
					To: recipient.email,
					From: `${env.NEXT_PUBLIC_SITE_TITLE} <${env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
					type: 'transactional',
				})

				sentCount++
			} catch (emailError) {
				const errorMessage =
					emailError instanceof Error ? emailError.message : String(emailError)
				errors.push(`Failed to send to ${recipient.email}: ${errorMessage}`)
			}
		}

		return {
			cohortId: cohort.id,
			emailId: emailResource.id,
			sent: sentCount,
			error: errors.length > 0 ? errors.join('; ') : null,
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		await log.error('cohort.reminder.send.error', {
			cohortId: reminderData.cohort.id,
			emailId: reminderData.emailResource.id,
			error: errorMessage,
		})

		return {
			cohortId: reminderData.cohort.id,
			emailId: reminderData.emailResource.id,
			sent: 0,
			error: errorMessage,
		}
	}
}
