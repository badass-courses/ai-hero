import { inngest } from '@/inngest/inngest.server'

type InngestSendPayload = Parameters<typeof inngest.send>[0]

/** Delays before retries 2 and 3, so a full failure waits well under 2 s. */
const RETRY_DELAYS_MS = [150, 400]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sends an Inngest event, retrying briefly on transport failures such as a
 * dropped socket (`fetch failed`). Three attempts, about 550 ms of backoff.
 *
 * @param payload - The event payload handed to `inngest.send`.
 * @param delaysMs - Backoff between attempts. Overridable for tests.
 * @returns The `inngest.send` result.
 * @throws The last send error once every attempt has failed.
 */
export async function sendWithRetry(
	payload: InngestSendPayload,
	delaysMs: readonly number[] = RETRY_DELAYS_MS,
) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await inngest.send(payload)
		} catch (error) {
			const delay = delaysMs[attempt]
			if (delay === undefined) throw error
			await sleep(delay)
		}
	}
}
