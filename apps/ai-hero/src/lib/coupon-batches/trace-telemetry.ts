import type { ReadableSpan } from '@opentelemetry/sdk-trace-node'
import { isPrivateCouponPath, scrubCouponTelemetry } from './telemetry'

export function scrubCouponSpan(span: ReadableSpan): ReadableSpan {
	const privateRequest =
		isPrivateCouponPath(span.name) ||
		['http.route', 'http.target', 'http.url', 'url.full', 'url.path'].some(
			(key) => {
				const value = span.attributes[key]
				return typeof value === 'string' && isPrivateCouponPath(value)
			},
		)
	return new Proxy(span, {
		get(target, property) {
			const value = Reflect.get(target, property, target)
			if (
				['attributes', 'events', 'status', 'name', 'links'].includes(
					String(property),
				)
			)
				return scrubCouponTelemetry(value, privateRequest)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}
