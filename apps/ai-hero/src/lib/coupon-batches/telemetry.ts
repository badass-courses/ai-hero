// Shared with Edge and browser telemetry. Keep Node-only selector code out.
const bearer = /c5comp_[0-9a-f]{40}/gi
const privatePath =
	/\/api\/commerce\/coupon-batches(?:[/?]|$)|\/api\/coursebuilder\/redeem(?:[/?]|$)/
const privateField =
	/^(?:authorization|cookie|cookies|headers|body|data|query_string)$|(?:\.|_)body(?:\.|_|$)|\.header\./i

export function redactCompBearer(value: string) {
	return value.replace(bearer, '[c5-comp-selector]')
}

/** Do not serialize a private API body (in either direction), PAT, or cookie
 * into SDK errors or request spans. Scrub bearer text in all app-owned traces,
 * including the legacy C5 page URL and any referer that points back to it. */
export function isPrivateCouponPath(value: string) {
	return privatePath.test(value)
}

export function scrubCouponTelemetry<T>(value: T, privateRequest = false): T {
	const seen = new WeakMap<object, unknown>()
	function walk(node: unknown, privateRequest = false): unknown {
		if (typeof node === 'string') return redactCompBearer(node)
		if (!node || typeof node !== 'object') return node
		if (node instanceof URL) return redactCompBearer(node.href)
		if (node instanceof Date) return node
		if (seen.has(node)) return seen.get(node)
		if (node instanceof Error) {
			const redacted: Record<string, unknown> = {
				name: redactCompBearer(node.name),
			}
			seen.set(node, redacted)
			redacted.message = redactCompBearer(node.message)
			if (typeof node.stack === 'string')
				redacted.stack = redactCompBearer(node.stack)
			if (node.cause) redacted.cause = walk(node.cause, privateRequest)
			return redacted
		}
		if (Array.isArray(node)) {
			const list: unknown[] = []
			seen.set(node, list)
			for (const item of node) list.push(walk(item, privateRequest))
			return list
		}
		const proto = Object.getPrototypeOf(node)
		if (proto !== Object.prototype && proto !== null)
			return '[non-plain telemetry value]'
		const source = Object.entries(node)
		const strip =
			privateRequest ||
			source.some(
				([key, value]) =>
					/(?:url|path|target|route|transaction|description|name)$/i.test(
						key,
					) &&
					typeof value === 'string' &&
					privatePath.test(value),
			)
		const out: Record<string, unknown> = Object.create(null)
		seen.set(node, out)
		for (const [key, child] of source) {
			if (!strip || !privateField.test(key))
				out[redactCompBearer(key)] = walk(child, strip)
		}
		return out
	}
	return walk(value, privateRequest) as T
}
