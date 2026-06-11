import { db } from '@/db'
import {
	DEFAULT_EMAIL_PREFERENCE_KEY,
	parseEmailPreferenceKey,
} from '@/coursebuilder/email-preferences'
import BasicEmail, { BasicEmailProps } from '@/emails/basic-email'
import { env } from '@/env.mjs'
import { EMAIL_SEND_BROADCAST } from '@/inngest/events/email-send-broadcast'
import { inngest } from '@/inngest/inngest.server'
import {
	getProviderEmailPreferences,
	syncLocalEmailPreferencesFromProvider,
} from '@/lib/email-preferences'
import { log, serializeError } from '@/server/logger'
import { NonRetriableError } from 'inngest'
import { Resend } from 'resend'

export async function sendAnEmail<ComponentPropsType = any>({
	Component,
	componentProps,
	Subject,
	To,
	From = `${env.NEXT_PUBLIC_SITE_TITLE} <${env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
	type = 'transactional',
	unsubscribeLinkUrl,
}: {
	Component: (props: ComponentPropsType) => React.JSX.Element
	componentProps: ComponentPropsType
	Subject: string
	From?: string
	To: string
	type?: 'transactional' | 'broadcast'
	unsubscribeLinkUrl?: string
}) {
	const resend = new Resend(process.env.RESEND_API_KEY)

	return resend.emails.send({
		from: From,
		to: [To],
		subject: Subject,
		react: Component(componentProps),
		headers:
			type === 'broadcast' && unsubscribeLinkUrl
				? {
						'List-Unsubscribe': `<${unsubscribeLinkUrl}>`,
					}
				: {},
	})
}

export const emailSendBroadcast = inngest.createFunction(
	{
		id: `email-send-broadcast`,
		name: 'Email: Send Broadcast',
	},
	{
		event: EMAIL_SEND_BROADCAST,
	},
	async ({ event, step }) => {
		const user = await step.run('load the user', async () => {
			return db.query.users.findFirst({
				where: (users, { eq }) => eq(users.id, event.data.toUserId),
			})
		})

		if (!user) {
			throw new NonRetriableError(
				`User not found with id: ${event.data.toUserId}`,
			)
		}

		const preferenceKey = parseEmailPreferenceKey(event.data.preferenceKey)
		const preferences = await step.run(
			'load provider preferences',
			async () => {
				try {
					return await getProviderEmailPreferences({
						subscriberEmail: user.email,
						source: 'broadcast-guard',
					})
				} catch (error) {
					await log.error('email-preferences.broadcast-guard.failed', {
						source: 'broadcast-guard',
						provider: 'convertkit',
						userId: user.id,
						preferenceKey,
						result: 'failed',
						error: serializeError(error),
					})
					throw error
				}
			},
		)

		const newsletterPreference = preferences[DEFAULT_EMAIL_PREFERENCE_KEY]
		const targetPreference = preferences[preferenceKey]

		if (!newsletterPreference?.subscribed || !targetPreference?.subscribed) {
			await log.info('email-preferences.broadcast-guard.skipped', {
				source: 'broadcast-guard',
				provider: 'convertkit',
				userId: user.id,
				preferenceKey,
				newsletterSubscribed: newsletterPreference?.subscribed ?? null,
				targetSubscribed: targetPreference?.subscribed ?? null,
				result: 'skipped',
			})
			return 'User has unsubscribed'
		}

		await step.run('sync local preference mirror', async () => {
			await syncLocalEmailPreferencesFromProvider({
				subscriberEmail: user.email,
				source: 'broadcast-guard',
			})
		})

		const unsubscribeUrl = new URL('/unsubscribed', env.NEXT_PUBLIC_URL)
		unsubscribeUrl.searchParams.set('preference', preferenceKey)
		const unsubscribeLinkUrl = unsubscribeUrl.toString()
		const preferencesLinkUrl = new URL(
			'/preferences',
			env.NEXT_PUBLIC_URL,
		).toString()

		return await step.run('send the email', async () => {
			return await sendAnEmail<BasicEmailProps>({
				Component: BasicEmail,
				componentProps: {
					body: `hi from ${process.env.NEXT_PUBLIC_SITE_TITLE}`,
					preview: `hi there!`,
					unsubscribeLinkUrl,
					preferencesLinkUrl,
					messageType: 'broadcast',
				},
				Subject: `${process.env.NEXT_PUBLIC_SITE_TITLE} Test`,
				To: user.email,
				type: 'broadcast',
				unsubscribeLinkUrl,
			})
		})
	},
)
