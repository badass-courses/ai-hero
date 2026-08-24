import { env } from '@/env.mjs'
import { SubscriberSchema, type Subscriber } from '@/schemas/subscriber'
import { log } from '@/server/logger'

import ConvertkitProvider, {
	ConvertKitApiError,
	subscribeToEndpoint,
} from '@coursebuilder/core/providers/convertkit'

const convertkitProvider = ConvertkitProvider({
	apiKey: env.CONVERTKIT_API_KEY,
	apiSecret: env.CONVERTKIT_API_SECRET,
	defaultListType: 'form',
	defaultListId: env.CONVERTKIT_SIGNUP_FORM,
})

type SubscribeToListOptions = Parameters<
	typeof convertkitProvider.subscribeToList
>[0]

type LeanKitSubscribeOptions = Pick<
	SubscribeToListOptions,
	'listId' | 'user'
> & {
	listType: 'sequence' | 'tag'
}

export type KitSubscribeFailureCode =
	| 'rate-limited'
	| 'rejected'
	| 'unresolved'
	| 'upstream'

export const KIT_SUBSCRIBE_FAILURE_PREFIX = 'AIH_KIT_SUBSCRIBE_ERROR:'

export class KitSubscribeError extends Error {
	readonly code: KitSubscribeFailureCode
	readonly status?: number
	readonly responseHeaders?: Record<string, string>

	constructor({
		code,
		status,
		responseHeaders,
	}: {
		code: KitSubscribeFailureCode
		status?: number
		responseHeaders?: Record<string, string>
	}) {
		super(`${KIT_SUBSCRIBE_FAILURE_PREFIX}${code}${status ? `:${status}` : ''}`)
		this.name = 'KitSubscribeError'
		this.code = code
		this.status = status
		this.responseHeaders = responseHeaders
	}
}

export function readKitSubscribeFailureCode(
	value: string,
): KitSubscribeFailureCode | undefined {
	const match = value.match(
		new RegExp(
			`${KIT_SUBSCRIBE_FAILURE_PREFIX}(rate-limited|rejected|unresolved|upstream)`,
		),
	)
	return match?.[1] as KitSubscribeFailureCode | undefined
}

async function subscribeWithFieldContract(
	options: SubscribeToListOptions,
): Promise<Subscriber> {
	const listType = options.listType ?? convertkitProvider.defaultListType

	await log.info('kit.write.logical_operation', {
		operation: 'subscribe-to-list-with-fields',
		logicalOperations: 1,
		context: 'coursebuilder-or-direct',
		listType,
	})

	try {
		// Keep Course Builder's full contract here. It creates missing custom fields,
		// writes them, and reads the subscriber back before callers confirm fields.
		const result = await convertkitProvider.subscribeToList(options)
		const subscriber = parseKitSubscriber({
			result,
			requestedEmail: options.user.email,
			allowMissingEmail: false,
		})
		await log.info('kit.write.outcome', {
			operation: 'subscribe-to-list-with-fields',
			outcome: 'succeeded',
			context: 'coursebuilder-or-direct',
			listType,
			attempts: 1,
			providerCallContract: 'coursebuilder-field-contract',
		})
		return subscriber
	} catch (error) {
		const boundaryError = toKitSubscribeError(error)
		await log.warn('kit.write.outcome', {
			operation: 'subscribe-to-list-with-fields',
			outcome: boundaryError.code === 'rate-limited' ? 'exhausted' : 'failed',
			context: 'coursebuilder-or-direct',
			listType,
			attempts: 1,
			status: boundaryError.status,
			reason: boundaryError.code,
		})
		throw boundaryError
	}
}

/**
 * One Kit POST for the launch-only shadow sequence/tag path.
 *
 * This seam deliberately has no fields property. Callers that need fields must
 * use emailListProvider.subscribeToList so Course Builder can create and verify
 * dynamic custom fields before local code confirms them.
 */
export async function subscribeToKitListWithoutFields(
	options: LeanKitSubscribeOptions,
): Promise<Subscriber> {
	const unsafeOptions = options as LeanKitSubscribeOptions & {
		fields?: Record<string, unknown>
	}
	if ('fields' in unsafeOptions) {
		throw new KitSubscribeError({ code: 'unresolved' })
	}

	try {
		const result = await subscribeToEndpoint({
			endPoint: kitSubscribeEndpoint(options.listType, options.listId),
			params: {
				email: options.user.email,
				first_name: options.user.name,
			},
			convertkitApiKey: env.CONVERTKIT_API_KEY,
		})
		return parseKitSubscriber({
			result,
			requestedEmail: options.user.email,
			allowMissingEmail: true,
		})
	} catch (error) {
		if (error instanceof KitSubscribeError) throw error
		if (
			error instanceof Error &&
			error.message.startsWith('Unexpected ConvertKit response structure')
		) {
			throw new KitSubscribeError({ code: 'unresolved' })
		}
		throw error
	}
}

export const emailListProvider = {
	...convertkitProvider,
	subscribeToList: subscribeWithFieldContract,
}

function parseKitSubscriber({
	result,
	requestedEmail,
	allowMissingEmail,
}: {
	result: unknown
	requestedEmail: string
	allowMissingEmail: boolean
}): Subscriber {
	if (!result || typeof result !== 'object') {
		throw new KitSubscribeError({ code: 'unresolved' })
	}

	const candidate = result as Record<string, unknown>
	const id = safeNumericSubscriberId(candidate.id)
	const normalizedRequestedEmail = requestedEmail.trim().toLowerCase()
	const hasEmail = candidate.email_address != null
	const returnedEmail =
		typeof candidate.email_address === 'string'
			? candidate.email_address.trim().toLowerCase()
			: undefined

	if (hasEmail && returnedEmail !== normalizedRequestedEmail) {
		throw new KitSubscribeError({ code: 'unresolved' })
	}
	if (!hasEmail && !allowMissingEmail) {
		throw new KitSubscribeError({ code: 'unresolved' })
	}

	try {
		const parsed = SubscriberSchema.parse({
			...candidate,
			id,
			email_address: hasEmail ? candidate.email_address : requestedEmail,
		})
		return { ...candidate, ...parsed }
	} catch {
		throw new KitSubscribeError({ code: 'unresolved' })
	}
}

function safeNumericSubscriberId(value: unknown) {
	const id =
		typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
	if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
		throw new KitSubscribeError({ code: 'unresolved' })
	}
	return id
}

function toKitSubscribeError(error: unknown) {
	if (error instanceof KitSubscribeError) return error
	if (error instanceof ConvertKitApiError) {
		return new KitSubscribeError({
			code:
				error.status === 429
					? 'rate-limited'
					: error.status >= 500
						? 'upstream'
						: 'rejected',
			status: error.status,
			responseHeaders: error.responseHeaders,
		})
	}
	return new KitSubscribeError({ code: 'upstream' })
}

function kitSubscribeEndpoint(
	listType: LeanKitSubscribeOptions['listType'],
	listId: string | number | undefined,
) {
	if (!listId) throw new Error('No listId provided')
	return `/${listType === 'tag' ? 'tags' : 'sequences'}/${listId}/subscribe`
}
