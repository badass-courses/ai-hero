import { db } from '@/db'
import { signupAttribution } from '@/db/schema'
import {
	isSyntheticOptInAttribution,
	parseOptInAttributionCookie,
	type OptInAttribution,
} from '@/lib/subscriber-marketing/opt-in-attribution'
import { log } from '@/server/logger'
import { guid } from '@coursebuilder/utils/guid'

export type RecordSignupAttributionInput = {
	email: string
	formId?: string | number | null
	kitSubscriberId?: string | number | null
	rawCookie?: string | null
}

export type RecordSignupAttributionResult =
	| 'captured'
	| 'skipped'
	| 'duplicate'
	| 'failed'

function asOptionalString(value: string | number | null | undefined) {
	if (value === null || value === undefined || value === '') return undefined
	return String(value)
}

function isDuplicateKeyError(error: unknown) {
	if (!error || typeof error !== 'object') return false
	const candidate = error as {
		code?: string | number
		errno?: number
		message?: string
		cause?: { code?: string | number; errno?: number; message?: string }
	}
	const code = candidate.code ?? candidate.cause?.code
	const errno = candidate.errno ?? candidate.cause?.errno
	const message = candidate.message ?? candidate.cause?.message ?? ''
	return (
		code === 'ER_DUP_ENTRY' ||
		code === 1062 ||
		errno === 1062 ||
		/duplicate entry/i.test(message)
	)
}

function clickIdsFromAttribution(attribution: OptInAttribution) {
	const clickIds = {
		...(attribution.gclid ? { gclid: attribution.gclid } : {}),
		...(attribution.gbraid ? { gbraid: attribution.gbraid } : {}),
		...(attribution.wbraid ? { wbraid: attribution.wbraid } : {}),
	}
	return Object.keys(clickIds).length > 0 ? clickIds : undefined
}

/**
 * Write one lean first-touch attribution row for a successful newsletter signup.
 * Fire-and-forget safe: never throws; duplicates and missing cookies are quiet skips.
 */
export async function recordSignupAttribution(
	input: RecordSignupAttributionInput,
): Promise<RecordSignupAttributionResult> {
	const formId = asOptionalString(input.formId) ?? 'default'
	const kitSubscriberId = asOptionalString(input.kitSubscriberId)

	try {
		const attribution = parseOptInAttributionCookie(input.rawCookie)
		if (!attribution) {
			await log.warn('signup.attribution.skipped', { reason: 'no_cookie' })
			return 'skipped'
		}

		if (isSyntheticOptInAttribution(attribution)) {
			await log.warn('signup.attribution.skipped', { reason: 'synthetic' })
			return 'skipped'
		}

		const capturedAt = new Date(attribution.capturedAt)
		if (Number.isNaN(capturedAt.getTime())) {
			await log.warn('signup.attribution.skipped', {
				reason: 'invalid_captured_at',
			})
			return 'skipped'
		}

		await db.insert(signupAttribution).values({
			id: guid(),
			email: input.email,
			kitSubscriberId,
			formId,
			landingPath: attribution.landingPath,
			referrer: attribution.referrer,
			utmSource: attribution.utmSource,
			utmMedium: attribution.utmMedium,
			utmCampaign: attribution.utmCampaign,
			utmContent: attribution.utmContent,
			utmTerm: attribution.utmTerm,
			clickIds: clickIdsFromAttribution(attribution),
			capturedAt,
		})

		await log.info('signup.attribution.captured', {
			formId,
			hasLandingPath: Boolean(attribution.landingPath),
			hasReferrer: Boolean(attribution.referrer),
			kitSubscriberId,
		})
		return 'captured'
	} catch (error) {
		if (isDuplicateKeyError(error)) {
			await log.warn('signup.attribution.skipped', {
				reason: 'duplicate',
				formId,
				kitSubscriberId,
			})
			return 'duplicate'
		}

		await log.error('signup.attribution.failed', {
			formId,
			error: error instanceof Error ? error.message : String(error),
		})
		return 'failed'
	}
}
