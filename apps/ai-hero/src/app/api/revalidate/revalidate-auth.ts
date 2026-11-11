import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Who may call /api/revalidate (sec-20261111-008).
 *
 * The route used to take `?secret=` and compare it to INNGEST_SIGNING_KEY, so
 * every call wrote the live signing key into request logs. It now has its own
 * secret, sent only as `Authorization: Bearer <REVALIDATE_SECRET>`.
 * A query-string secret is refused outright, so an old command can't keep
 * leaking a key into logs.
 */
export type RevalidateAuth =
	| { ok: true }
	| { ok: false; status: 400 | 401 | 503; error: string }

const digest = (value: string) => createHash('sha256').update(value).digest()

export function checkRevalidateAuth(input: {
	configuredSecret: string | undefined
	authorization: string | null
	hasQuerySecret: boolean
}): RevalidateAuth {
	if (input.hasQuerySecret) {
		return {
			ok: false,
			status: 400,
			error:
				'Send the secret as an Authorization: Bearer header, not a query param',
		}
	}
	if (!input.configuredSecret) {
		return { ok: false, status: 503, error: 'Revalidation is not configured' }
	}
	const match = /^Bearer (.+)$/.exec(input.authorization ?? '')
	if (!match) {
		return { ok: false, status: 401, error: 'Unauthorized' }
	}
	// Hash both sides so lengths match and the compare stays constant-time.
	if (!timingSafeEqual(digest(match[1]!), digest(input.configuredSecret))) {
		return { ok: false, status: 401, error: 'Unauthorized' }
	}
	return { ok: true }
}
