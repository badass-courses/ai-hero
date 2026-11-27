import { isPrivateCompReference } from './namespace'

export const isReservedCouponField = (field: unknown) =>
	typeof field === 'string' && isPrivateCompReference(field.trim())

export function hasReservedCouponField(
	values: Pick<URLSearchParams, 'getAll'> | Pick<FormData, 'getAll'>,
	keys: readonly string[],
) {
	return keys.some((key) => values.getAll(key).some(isReservedCouponField))
}

function couponFieldsAreReserved(
	body: Record<string, unknown> | null,
	keys: readonly string[],
) {
	return keys.some((key) => isReservedCouponField(body?.[key]))
}

export async function readCouponRequestBody(
	request: Request,
	keys: readonly string[],
): Promise<{
	json: Record<string, unknown> | null
	isJson: boolean
	reserved: boolean
}> {
	const mediaType = request.headers
		.get('content-type')
		?.split(';', 1)[0]
		?.trim()
		.toLowerCase()
	const isJson = mediaType === 'application/json'
	const empty = { json: null, isJson, reserved: false }
	if (!request.body) return empty
	const copy = request.clone()
	const formKeys = [...keys, 'coupon']
	if (mediaType === 'multipart/form-data') {
		try {
			return {
				...empty,
				reserved: hasReservedCouponField(await copy.formData(), formKeys),
			}
		} catch {
			return empty
		}
	}
	const raw = await copy.text()
	if (isJson || raw.trimStart().startsWith('{')) {
		try {
			const value: unknown = JSON.parse(raw)
			if (!value || typeof value !== 'object' || Array.isArray(value))
				return empty
			const json = value as Record<string, unknown>
			return { json, isJson, reserved: couponFieldsAreReserved(json, keys) }
		} catch {
			// Leave malformed requests to the legacy parser. Never scan raw bytes
			// for a prefix that might be part of an address or other field.
			return empty
		}
	}
	return {
		...empty,
		reserved: hasReservedCouponField(new URLSearchParams(raw), formKeys),
	}
}
