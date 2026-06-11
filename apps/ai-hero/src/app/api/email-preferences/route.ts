import { NextRequest, NextResponse } from 'next/server'
import { parseEmailPreferenceKey } from '@/coursebuilder/email-preferences'
import {
	getEmailPreferenceDefinition,
	getEmailPreferenceSubscriber,
	getProviderEmailPreferences,
	syncLocalEmailPreference,
	syncLocalEmailPreferencesFromProvider,
	updateProviderEmailPreference,
} from '@/lib/email-preferences'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log, serializeError } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

function unauthorized(status: 401 | 403, message: string) {
	return NextResponse.json({ error: message }, { status, headers: corsHeaders })
}

async function requireAdmin(request: NextRequest) {
	const { ability, user } = await getUserAbilityForRequest(request)

	if (!user)
		return { ok: false as const, response: unauthorized(401, 'Unauthorized') }
	if (!ability.can('manage', 'all')) {
		return {
			ok: false as const,
			response: unauthorized(403, 'Forbidden: Admin access required'),
		}
	}

	return { ok: true as const, user }
}

/**
 * GET /api/email-preferences?subscriberId=123&email=x@y.com
 * Reads provider-canonical preference state and local mirror status.
 */
const getEmailPreferencesHandler = async (request: NextRequest) => {
	const auth = await requireAdmin(request)
	if (!auth.ok) return auth.response

	const { searchParams } = new URL(request.url)
	const subscriberId = searchParams.get('subscriberId') ?? undefined
	const subscriberEmail = searchParams.get('email') ?? undefined
	const sync = searchParams.get('sync') === 'true'

	if (!subscriberId && !subscriberEmail) {
		return NextResponse.json(
			{ error: 'subscriberId or email is required' },
			{ status: 400, headers: corsHeaders },
		)
	}

	try {
		const result = sync
			? await syncLocalEmailPreferencesFromProvider({
					subscriberId,
					subscriberEmail,
					source: 'admin',
				})
			: {
					subscriber: await getEmailPreferenceSubscriber({
						subscriberId,
						subscriberEmail,
						source: 'admin',
					}),
					preferences: await getProviderEmailPreferences({
						subscriberId,
						subscriberEmail,
						source: 'admin',
					}),
				}

		await log.info('email-preferences.admin.inspect', {
			source: 'admin',
			provider: 'convertkit',
			userId: auth.user.id,
			kitSubscriberId: subscriberId,
			hasSubscriberEmail: Boolean(subscriberEmail),
			result: 'success',
			sync,
		})

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		await log.error('email-preferences.admin.inspect.failed', {
			source: 'admin',
			provider: 'convertkit',
			userId: auth.user.id,
			kitSubscriberId: subscriberId,
			hasSubscriberEmail: Boolean(subscriberEmail),
			result: 'failed',
			error: serializeError(error),
		})

		return NextResponse.json(
			{ error: 'Failed to inspect email preferences' },
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const GET = withSkill(getEmailPreferencesHandler)

/**
 * POST /api/email-preferences
 * Updates one provider preference and mirrors it locally.
 */
const updateEmailPreferencesHandler = async (request: NextRequest) => {
	const auth = await requireAdmin(request)
	if (!auth.ok) return auth.response

	const body = await request.json().catch(() => null)
	const subscriberId = body?.subscriberId?.toString()
	const subscriberEmail = body?.email?.toString()
	const preferenceKey = parseEmailPreferenceKey(body?.preferenceKey?.toString())
	const subscribed = body?.subscribed === true
	const syncOnly = body?.syncOnly === true

	if (!subscriberId && !subscriberEmail) {
		return NextResponse.json(
			{ error: 'subscriberId or email is required' },
			{ status: 400, headers: corsHeaders },
		)
	}

	try {
		if (syncOnly) {
			const result = await syncLocalEmailPreferencesFromProvider({
				subscriberId,
				subscriberEmail,
				source: 'cli',
			})

			await log.info('email-preferences.cli.repair', {
				source: 'cli',
				provider: 'convertkit',
				userId: auth.user.id,
				kitSubscriberId: subscriberId,
				hasSubscriberEmail: Boolean(subscriberEmail),
				result: 'synced',
			})

			return NextResponse.json(result, { headers: corsHeaders })
		}

		const preference = getEmailPreferenceDefinition(preferenceKey)
		const subscriber = await getEmailPreferenceSubscriber({
			subscriberId,
			subscriberEmail,
			source: 'cli',
		})
		const state = await updateProviderEmailPreference({
			subscriberId,
			subscriberEmail,
			preference,
			subscribed,
			source: 'cli',
		})

		await syncLocalEmailPreference({
			email: subscriber?.email_address ?? subscriberEmail,
			preference,
			subscribed: state.subscribed,
			source: 'cli',
		})

		await log.info('email-preferences.cli.repair', {
			source: 'cli',
			provider: 'convertkit',
			userId: auth.user.id,
			kitSubscriberId: subscriberId,
			hasSubscriberEmail: Boolean(subscriberEmail),
			preferenceKey,
			result: state.status,
		})

		return NextResponse.json(
			{ subscriber, preference: state },
			{ headers: corsHeaders },
		)
	} catch (error) {
		await log.error('email-preferences.cli.repair.failed', {
			source: 'cli',
			provider: 'convertkit',
			userId: auth.user.id,
			kitSubscriberId: subscriberId,
			hasSubscriberEmail: Boolean(subscriberEmail),
			preferenceKey,
			result: 'failed',
			error: serializeError(error),
		})

		return NextResponse.json(
			{ error: 'Failed to update email preferences' },
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const POST = withSkill(updateEmailPreferencesHandler)
