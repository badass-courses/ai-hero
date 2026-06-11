import { env } from '@/env.mjs'
import BasicEmail from '@/emails/basic-email'
import { NewEmailSchema } from '@/lib/emails'
import { getEmailSimple, updateEmailSimple } from '@/lib/emails-query'
import {
	attachReminderEmailToCohort,
	createAndAttachReminderEmailToCohort,
	detachReminderEmailFromCohort,
	getAllCohortReminderEmails,
	getCohortReminderEmails,
	getCohortReminderRecipients,
	updateReminderEmailScheduleForCohort,
} from '@/lib/cohort-email-reminders-query'
import { getAllWorkshopsInCohort, getCohort } from '@/lib/cohorts-query'
import { log } from '@/server/logger'
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from '@/trpc/api/trpc'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { Liquid } from 'liquidjs'
import { z } from 'zod'

const CohortReminderScheduleSchema = z.object({
	hoursInAdvance: z.number().min(1).max(336).optional(),
	sendAt: z.string().datetime().nullable().optional(),
})

const CohortReminderMutationSchema = z.object({
	cohortId: z.string(),
	emailId: z.string(),
	schedule: CohortReminderScheduleSchema.optional(),
})

const CohortReminderFormSchema = z.object({
	emailId: z.string(),
	cohortId: z.string(),
	fields: NewEmailSchema.shape.fields,
	schedule: CohortReminderScheduleSchema.optional(),
})

export const cohortsRouter = createTRPCRouter({
	getCohortReminderEmails: publicProcedure
		.input(z.object({ cohortId: z.string() }))
		.query(async ({ input }) => {
			return await getCohortReminderEmails(input.cohortId)
		}),
	getAllCohortReminderEmails: publicProcedure.query(async () => {
		return await getAllCohortReminderEmails()
	}),
	attachReminderEmailToCohort: protectedProcedure
		.input(CohortReminderMutationSchema)
		.mutation(async ({ input }) => {
			return await attachReminderEmailToCohort(
				input.cohortId,
				input.emailId,
				input.schedule,
			)
		}),
	detachReminderEmailFromCohort: protectedProcedure
		.input(
			z.object({
				cohortId: z.string(),
				emailId: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			return await detachReminderEmailFromCohort(input.cohortId, input.emailId)
		}),
	createAndAttachReminderEmailToCohort: protectedProcedure
		.input(
			z.object({
				cohortId: z.string(),
				input: NewEmailSchema,
				schedule: CohortReminderScheduleSchema.optional(),
			}),
		)
		.mutation(async ({ input }) => {
			return await createAndAttachReminderEmailToCohort(
				input.cohortId,
				input.input,
				input.schedule,
			)
		}),
	updateReminderEmailScheduleForCohort: protectedProcedure
		.input(CohortReminderMutationSchema)
		.mutation(async ({ input }) => {
			return await updateReminderEmailScheduleForCohort(
				input.cohortId,
				input.emailId,
				input.schedule,
			)
		}),
	updateReminderEmailForCohort: protectedProcedure
		.input(CohortReminderFormSchema)
		.mutation(async ({ input }) => {
			const email = await getEmailSimple(input.emailId)
			if (!email) {
				throw new Error('Email not found')
			}

			await updateReminderEmailScheduleForCohort(
				input.cohortId,
				input.emailId,
				input.schedule,
			)

			return await updateEmailSimple({
				...email,
				id: input.emailId,
				fields: {
					...email.fields,
					...input.fields,
				},
			})
		}),
	previewReminderEmailForCohort: protectedProcedure
		.input(z.object({ cohortId: z.string(), emailId: z.string() }))
		.query(async ({ input }) => {
			const cohort = await getCohort(input.cohortId)
			if (!cohort) throw new Error('Cohort not found')

			const email = await getEmailSimple(input.emailId)
			if (!email) throw new Error('Email not found')

			const recipients = await getCohortReminderRecipients(input.cohortId)
			const workshops = await getAllWorkshopsInCohort(input.cohortId)

			const liquid = new Liquid()
			const sampleUser = recipients[0] || {
				name: 'Learner',
				email: 'learner@example.com',
			}
			const url = `${env.NEXT_PUBLIC_URL}/cohorts/${cohort.fields.slug}`

			const renderedSubject = await liquid.parseAndRender(
				email.fields?.subject || '',
				{
					cohort,
					workshops,
					title: cohort.fields.title,
					url,
					user: sampleUser,
				},
			)
			const renderedBody = await liquid.parseAndRender(
				email.fields?.body || '',
				{
					cohort,
					workshops,
					title: cohort.fields.title,
					url,
					user: sampleUser,
				},
			)

			return {
				subject: renderedSubject,
				body: renderedBody,
				recipientCount: recipients.length,
				recipients: recipients.map((recipient) => ({
					name: recipient.name,
					email: recipient.email,
				})),
			}
		}),
	sendReminderEmailNowForCohort: protectedProcedure
		.input(z.object({ cohortId: z.string(), emailId: z.string() }))
		.mutation(async ({ input }) => {
			const cohort = await getCohort(input.cohortId)
			if (!cohort) throw new Error('Cohort not found')

			const email = await getEmailSimple(input.emailId)
			if (!email) throw new Error('Email not found')

			const recipients = await getCohortReminderRecipients(input.cohortId)
			const workshops = await getAllWorkshopsInCohort(input.cohortId)

			if (recipients.length === 0) {
				return { sent: 0, errorCount: 0 }
			}

			const liquid = new Liquid()
			const emailBody =
				email.fields?.body ||
				'Your cohort starts soon. Please check your dashboard.'
			const emailSubject =
				email.fields?.subject || `Reminder: ${cohort.fields.title}`
			const url = `${env.NEXT_PUBLIC_URL}/cohorts/${cohort.fields.slug}`

			let sentCount = 0
			let errorCount = 0

			for (const recipient of recipients) {
				try {
					const parsedBody = await liquid.parseAndRender(emailBody, {
						cohort,
						workshops,
						title: cohort.fields.title,
						url,
						user: recipient,
					})
					const parsedSubject = await liquid.parseAndRender(emailSubject, {
						cohort,
						workshops,
						title: cohort.fields.title,
						url,
						user: recipient,
					})

					await sendAnEmail({
						Component: BasicEmail,
						componentProps: { body: parsedBody },
						Subject: parsedSubject,
						To: recipient.email,
						From: `${env.NEXT_PUBLIC_SITE_TITLE} <${env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
						type: 'transactional',
					})
					sentCount++
				} catch (err) {
					await log.error('cohorts.reminder.error', {
						cohortId: input.cohortId,
						emailId: input.emailId,
						recipientEmail: recipient.email,
						error: err instanceof Error ? err.message : String(err),
					})
					errorCount++
				}
			}

			return { sent: sentCount, errorCount }
		}),
})
