import { AI_CODING_CRASH_COURSE_PURCHASER_TAG_ID } from '@/lib/crash-course-purchaser-tag'

const KIT_V4_BASE_URL = 'https://api.kit.com/v4'

export type KitV4Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export type CrashCoursePurchaserTagger = (
	subscriberId: string,
) => Promise<{ subscriberId: string }>

export function getRequiredKitV4ApiKey() {
	const apiKey = process.env.CONVERTKIT_V4_API_KEY
	if (!apiKey) throw new Error('CONVERTKIT_V4_API_KEY is required')
	return apiKey
}

export function createCrashCoursePurchaserTagger({
	apiKey,
	fetcher = fetch,
}: {
	apiKey: string
	fetcher?: KitV4Fetcher
}): CrashCoursePurchaserTagger {
	return async (subscriberId) => {
		const response = await fetcher(
			`${KIT_V4_BASE_URL}/tags/${AI_CODING_CRASH_COURSE_PURCHASER_TAG_ID}/subscribers/${encodeURIComponent(subscriberId)}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Kit-Api-Key': apiKey,
				},
				body: JSON.stringify({}),
			},
		)

		if (!response.ok) {
			throw new Error(
				`Kit purchaser tag write failed with HTTP ${response.status}`,
			)
		}

		let payload: unknown
		try {
			payload = await response.json()
		} catch {
			throw new Error('Kit purchaser tag response was not valid JSON')
		}

		const returnedId = readReturnedSubscriberId(payload)
		if (returnedId !== subscriberId) {
			throw new Error('Kit purchaser tag response subscriber did not match')
		}

		return { subscriberId: returnedId }
	}
}

function readReturnedSubscriberId(payload: unknown) {
	if (!isRecord(payload) || !isRecord(payload.subscriber)) return undefined
	const id = payload.subscriber.id
	if (typeof id !== 'string' && typeof id !== 'number') return undefined
	return String(id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}
