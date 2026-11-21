'use server'

import { headers } from 'next/headers'
import { scheduleProductEvents } from '@/lib/subscriber-marketing/product-events-live'
import BasicEmail from '@/emails/basic-email'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { Ratelimit } from '@upstash/ratelimit'
import sanitizeHtml from 'sanitize-html'

import { suggestRoute } from './training-route'
import {
	getTeamInquirySchema,
	type TeamInquiryContext,
	type TeamInquiryFormValues,
} from './team-inquiry-schema'

export type SendTeamInquiryOptions = TeamInquiryFormValues & {
	context?: TeamInquiryContext
}

export async function sendTeamInquiry({
	name,
	email,
	companyName,
	teamSize,
	message,
	country,
	trainingType,
	trainingLocation,
	trainingCountry,
	engineersToTrain,
	format,
	topics,
	timing,
	partnerPreference,
	specificPartner,
	website,
	timestamp,
	context,
}: SendTeamInquiryOptions) {
	try {
		const headersList = await headers()
		const ip = headersList.get('x-forwarded-for') || 'unknown'
		const userAgent = headersList.get('user-agent') || 'unknown'

		// Check honeypot
		if (website) {
			await log.info('team_inquiry.spam.honeypot', {
				ip,
				userAgent,
				email,
				companyName,
				teamSize,
			})
			return { success: true }
		}

		// Validate submission timing
		const submissionTime = new Date()
		const startTime = new Date(timestamp)
		const timeDiff = submissionTime.getTime() - startTime.getTime()

		if (timeDiff < 3000) {
			await log.info('team_inquiry.spam.timing', {
				ip,
				userAgent,
				email,
				companyName,
				timeDiff,
				timestamp,
				submissionTime: submissionTime.toISOString(),
			})
			return { success: true }
		}

		if (timeDiff > 3600000) {
			return {
				error:
					'This form expired. Copy your answers before reloading the page, then send your inquiry again.',
			}
		}

		// Rate limiting
		const ratelimit = new Ratelimit({
			redis,
			limiter: Ratelimit.slidingWindow(3, '24 h'),
		})

		const rateLimit = await ratelimit.limit(`team_inquiry_${ip}`)

		await log.info('team_inquiry.ratelimit', {
			ip,
			userAgent,
			limit: rateLimit.limit,
			remaining: rateLimit.remaining,
			reset: rateLimit.reset,
			withinLimit: rateLimit.success,
		})

		if (!rateLimit.success) {
			return { success: true }
		}

		let partnerDetails = ''
		let trainingSubject = ''
		let routingLog = {}
		if (context?.source === 'training-partners') {
			const validation = getTeamInquirySchema(context.source).safeParse({
				name,
				email,
				companyName,
				teamSize,
				message,
				country,
				trainingType,
				trainingLocation,
				trainingCountry,
				engineersToTrain,
				format,
				topics,
				timing,
				partnerPreference,
				specificPartner,
				website,
				timestamp,
			})
			if (!validation.success) {
				return {
					error: validation.error.issues[0]?.message || 'Invalid submission',
				}
			}
			const data = validation.data
			const route = suggestRoute(data)
			const live = data.trainingType === 'live'
			const clean = (value: string) =>
				sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })
			trainingSubject = `Training request: ${clean(companyName).replace(/[\r\n]/g, ' ')}, ${data.country}, route ${route.route} (${route.reason})`
			const details = {
				country: data.country,
				trainingType: data.trainingType,
				trainingLocation: data.trainingLocation || 'same',
				trainingCountry:
					data.trainingLocation === 'elsewhere'
						? data.trainingCountry
						: data.country,
				engineersToTrain: live ? data.engineersToTrain : undefined,
				format: live ? data.format : undefined,
				topics: live ? data.topics : undefined,
				timing: live ? data.timing : undefined,
				partnerPreference: live ? data.partnerPreference || 'none' : 'none',
				specificPartner:
					live && data.partnerPreference === 'specific'
						? data.specificPartner?.trim()
						: undefined,
				suggestedRoute: route.route,
				routeReason: route.reason,
			}
			routingLog = details
			partnerDetails = [
				`Country: ${details.country}`,
				`Training type: ${details.trainingType}`,
				`Training location: ${details.trainingLocation}`,
				`Training country: ${details.trainingCountry}`,
				`Engineers to train: ${details.engineersToTrain || 'Not applicable'}`,
				`Format: ${details.format || 'Not applicable'}`,
				`Topics: ${details.topics?.join(', ') || 'Not applicable'}`,
				`Timing: ${details.timing || 'Not applicable'}`,
				`Partner preference: ${clean(route.partnerPreference)}`,
				`Suggested route: ${route.route} (${route.reason})`,
			].join('\n      ')
		}

		// Only send email if we pass all spam checks
		const body = `
      Name: ${name}
      Company: ${companyName}
      Team Size: ${teamSize}
      Email: ${email}
      ${partnerDetails}
      Message: ${message ? sanitizeHtml(message) : 'No message provided'}
      
      Source: ${context?.source || 'Direct'}
      URL: ${context?.url || 'N/A'}
      Submission Time: ${submissionTime.toISOString()}
      Form Load Time: ${timestamp}
      IP: ${ip}
      User Agent: ${userAgent}
    `

		await sendAnEmail({
			Component: BasicEmail,
			componentProps: {
				body,
				messageType: 'transactional',
			},
			Subject:
				context?.source === 'training-partners'
					? trainingSubject
					: `Team Inquiry from ${companyName} (${teamSize} employees)`,
			To: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			ReplyTo: email,
			type: 'transactional',
		})

		scheduleProductEvents(
			async () => email,
			[
				{
					_tag: 'TeamIntent',
					intent: 'seats',
					sourceId: 'team-inquiry',
					at: Date.now(),
				},
			],
		)

		// Log successful submission
		await log.info('team_inquiry.submitted', {
			ip,
			userAgent,
			email,
			companyName,
			teamSize,
			country,
			trainingType,
			...routingLog,
			source: context?.source || 'Direct',
			url: context?.url,
		})

		return { success: true }
	} catch (error: any) {
		// Log actual errors
		await log.error('team_inquiry.error', {
			error: error.message,
			stack: error.stack,
		})
		return { error: 'Unable to send inquiry. Please try again.' }
	}
}
