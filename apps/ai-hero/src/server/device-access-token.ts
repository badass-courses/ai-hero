/** Analytics device tokens are valid for 90 days from creation. */
export const DEVICE_TOKEN_TTL_HOURS = 90 * 24
const DEVICE_TOKEN_TTL_MS = DEVICE_TOKEN_TTL_HOURS * 60 * 60 * 1000

export type DeviceAccessTokenActivity = {
	revokedAt?: Date | string | null
	expiresAt?: Date | string | null
	createdAt?: Date | string | null
}

/**
 * Shared credential policy for device-access-token consumers.
 * Rows without an explicit expiry retain the legacy createdAt fallback.
 */
export function isDeviceAccessTokenActive(
	token: DeviceAccessTokenActivity,
	now = Date.now(),
) {
	if (token.revokedAt) return false
	if (token.expiresAt) {
		return new Date(token.expiresAt).getTime() > now
	}
	if (token.createdAt) {
		return now - new Date(token.createdAt).getTime() <= DEVICE_TOKEN_TTL_MS
	}
	return true
}
