import { slackProvider } from '@/coursebuilder/slack-provider'
import { log } from '@/server/logger'

type AlertSeverity = 'warning' | 'error'

export type PurchaseBenefitTelemetryEnvelope = {
	[key: string]: unknown
	purchaseBenefitId?: string | null
	purchaseId?: string | null
	bulkCouponId?: string | null
	redeemedPurchaseId?: string | null
	userId?: string | null
	userEmail?: string | null
	productId?: string | null
	resourceId?: string | null
	resourceType?: string | null
	welcomeEmailResourceId?: string | null
	stripeQuoteId?: string | null
	stripeInvoiceId?: string | null
	stripeCheckoutSessionId?: string | null
	frontConversationId?: string | null
	reason?: string | null
	errors?: unknown
}

function compactEnvelope(envelope: PurchaseBenefitTelemetryEnvelope) {
	return Object.fromEntries(
		Object.entries(envelope).filter(([, value]) => value !== undefined),
	)
}

function formatFields(envelope: PurchaseBenefitTelemetryEnvelope) {
	const toFieldValue = (value: unknown) => {
		const raw = typeof value === 'string' ? value : JSON.stringify(value)
		const safe = raw.length > 700 ? `${raw.slice(0, 700)}...` : raw
		return typeof value === 'string' ? safe : `\`${safe}\``
	}

	return Object.entries(compactEnvelope(envelope))
		.filter(([, value]) => value !== null && value !== undefined)
		.slice(0, 20)
		.map(([key, value]) => ({
			title: key,
			value: toFieldValue(value),
			short: true,
		}))
}

export async function logPurchaseBenefitReceipt(
	event: string,
	envelope: PurchaseBenefitTelemetryEnvelope,
) {
	await log.info(event, compactEnvelope(envelope))
}

export async function alertPurchaseBenefitOperator(input: {
	event: string
	title: string
	message: string
	severity?: AlertSeverity
	envelope: PurchaseBenefitTelemetryEnvelope
}) {
	const severity = input.severity ?? 'warning'
	const attrs = compactEnvelope(input.envelope)

	if (severity === 'error') {
		await log.error(input.event, attrs)
	} else {
		await log.warn(input.event, attrs)
	}

	if (!slackProvider.defaultChannelId) {
		await log.warn('purchase_benefit.slack_alert.skipped_no_channel', {
			event: input.event,
			...attrs,
		})
		return { sent: false, reason: 'missing-default-channel' }
	}

	try {
		await slackProvider.sendNotification({
			channel: slackProvider.defaultChannelId,
			text: input.title,
			attachments: [
				{
					fallback: input.message,
					color: severity === 'error' ? '#d92d20' : '#f79009',
					title: input.title,
					text: input.message,
					fields: formatFields(input.envelope),
				},
			],
		})
		return { sent: true }
	} catch (error) {
		await log.error('purchase_benefit.slack_alert.failed', {
			event: input.event,
			error: error instanceof Error ? error.message : String(error),
			...attrs,
		})
		return { sent: false, reason: 'slack-send-failed' }
	}
}
