import type { ReadableSpan } from '@opentelemetry/sdk-trace-node'
import {
	containsCouponTelemetry,
	isPrivateCouponPath,
	scrubCouponTelemetry,
} from './telemetry'

export function scrubCouponSpan(span: ReadableSpan): ReadableSpan {
	if (
		!containsCouponTelemetry([
			span.name,
			span.attributes,
			span.events,
			span.status,
			span.links,
		])
	)
		return span
	const privateRequest =
		isPrivateCouponPath(span.name, true) ||
		['http.route', 'http.target', 'http.url', 'url.full', 'url.path'].some(
			(key) => {
				const value = span.attributes[key]
				return typeof value === 'string' && isPrivateCouponPath(value, true)
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

export function scrubCouponSpans(spans: ReadableSpan[]): ReadableSpan[] {
	let output: ReadableSpan[] | undefined
	for (const [index, span] of spans.entries()) {
		const safe = scrubCouponSpan(span)
		if (safe !== span) output ??= spans.slice()
		if (output) output[index] = safe
	}
	return output ?? spans
}
