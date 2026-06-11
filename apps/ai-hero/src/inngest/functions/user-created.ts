import { db } from '@/db'
import { emailPreferenceDefinitions } from '@/coursebuilder/email-preferences'
import { communicationPreferences, userRoles } from '@/db/schema'
import BasicEmail from '@/emails/basic-email'
import { USER_CREATED_EVENT } from '@/inngest/events/user-created'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { Liquid } from 'liquidjs'
import { customAlphabet } from 'nanoid'

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 5)

export const userCreated = inngest.createFunction(
	{
		id: `user created`,
		name: 'User Created',
		idempotency: 'event.user.email',
	},
	{
		event: USER_CREATED_EVENT,
	},
	async ({ event, step }) => {
		const email = {
			body: `{{user.email}} signed up.`,
			subject: `Signup from {{user.email}} on ${process.env.NEXT_PUBLIC_SITE_TITLE}`,
		}

		// Step 1: Assign user role (independent of preferences — must not be blocked)
		await step.run('create user role', async () => {
			const userRole = await db.query.roles.findFirst({
				where: (ur, { eq }) => eq(ur.name, 'user'),
			})

			if (!userRole) {
				await log.warn('user-created.role-not-found', {
					userId: event.user.id,
					email: event.user.email,
					roleName: 'user',
				})
				return
			}

			await db.insert(userRoles).values({
				roleId: userRole.id,
				userId: event.user.id,
			})
		})

		// Step 2: Set up communication preferences (graceful — skip if tables empty)
		await step.run('create the user preference', async () => {
			const preferenceChannel = await db.query.communicationChannel.findFirst({
				where: (cc, { eq }) => eq(cc.name, 'Email'),
			})

			if (!preferenceChannel) {
				// Tables are empty — skip preference creation instead of
				// throwing NonRetriableError that blocks all onboarding.
				await log.warn('user-created.preference-config-missing', {
					userId: event.user.id,
					email: event.user.email,
					hasPreferenceType: false,
					hasPreferenceChannel: !!preferenceChannel,
				})
				return
			}

			for (const preference of emailPreferenceDefinitions) {
				const preferenceType =
					await db.query.communicationPreferenceTypes.findFirst({
						where: (cpt, { eq }) =>
							eq(cpt.name, preference.localPreferenceTypeName),
					})

				if (!preferenceType) {
					await log.warn('user-created.preference-config-missing', {
						userId: event.user.id,
						email: event.user.email,
						preferenceKey: preference.key,
						hasPreferenceType: false,
						hasPreferenceChannel: true,
					})
					continue
				}

				await db.insert(communicationPreferences).values({
					id: nanoid(),
					userId: event.user.id,
					preferenceTypeId: preferenceType.id,
					channelId: preferenceChannel.id,
					active: preference.defaultSubscribed,
					updatedAt: new Date(),
					optInAt: preference.defaultSubscribed ? new Date() : null,
					createdAt: new Date(),
				})

				await log.info('user-created.preference-created', {
					userId: event.user.id,
					preferenceKey: preference.key,
					preferenceTypeId: preferenceType.id,
					channelId: preferenceChannel.id,
				})
			}
		})

		// Step 3: Send notification email
		const parsedEmailBody: string = await step.run(
			`parse email body`,
			async () => {
				try {
					const engine = new Liquid()
					return engine.parseAndRender(email.body, { user: event.user })
				} catch (e: any) {
					await log.error('user-created.email-parse.error', {
						userId: event.user.id,
						email: event.user.email,
						error: String(e),
					})
					return email.body
				}
			},
		)

		const parsedEmailSubject: string = await step.run(
			`parse email subject`,
			async () => {
				try {
					const engine = new Liquid()
					return engine.parseAndRender(email.subject, { user: event.user })
				} catch (e) {
					return email.subject
				}
			},
		)

		const sendResponse = await step.run('send the email', async () => {
			// return await sendAnEmail({
			// 	Component: BasicEmail,
			// 	componentProps: {
			// 		body: parsedEmailBody,
			// 	},
			// 	Subject: parsedEmailSubject,
			// 	To: event.user.email,
			// 	type: 'broadcast',
			// })
		})

		await log.info('user-created.completed', {
			userId: event.user.id,
			email: event.user.email,
		})

		return { sendResponse, email, user: event.user }
	},
)
