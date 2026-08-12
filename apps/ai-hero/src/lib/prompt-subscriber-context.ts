import 'server-only'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { hashEmailForKit } from '@/lib/email-preferences'

const KIT_LOOKUP_TIMEOUT_MS = 1_500

export type PromptSubscriberContext = {
	status: 'absent' | 'invalid' | 'recognized' | 'verified' | 'unavailable'
	provider: 'kit'
	readAccess: 'published_prompt_and_event_only'
	identityAssurance: 'none' | 'subscriber_id' | 'subscriber_id_and_email_hash'
}

export async function resolvePromptSubscriberContext({
	subscriberId,
	shKit,
}: {
	subscriberId?: string | null
	shKit?: string | null
}): Promise<PromptSubscriberContext> {
	const normalizedId = subscriberId?.trim()
	const normalizedHash = shKit?.trim().toLowerCase()

	if (!normalizedId) return result('absent', 'none')
	if (!/^\d{1,20}$/.test(normalizedId)) return result('invalid', 'none')

	try {
		const subscriber = await withTimeout(
			emailListProvider.getSubscriber(normalizedId),
			KIT_LOOKUP_TIMEOUT_MS,
		)
		if (!subscriber || String(subscriber.id) !== normalizedId) {
			return result('invalid', 'none')
		}

		if (
			normalizedHash &&
			/^[a-f0-9]{64}$/.test(normalizedHash) &&
			subscriber.email_address &&
			hashEmailForKit(subscriber.email_address) === normalizedHash
		) {
			return result('verified', 'subscriber_id_and_email_hash')
		}

		return result('recognized', 'subscriber_id')
	} catch {
		return result('unavailable', 'none')
	}
}

function result(
	status: PromptSubscriberContext['status'],
	identityAssurance: PromptSubscriberContext['identityAssurance'],
): PromptSubscriberContext {
	return {
		status,
		provider: 'kit',
		readAccess: 'published_prompt_and_event_only',
		identityAssurance,
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race<T | null>([
			promise,
			new Promise<null>((resolve) => {
				timeout = setTimeout(() => resolve(null), timeoutMs)
			}),
		])
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}
