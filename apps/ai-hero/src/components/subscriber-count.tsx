import * as React from 'react'
import { getTotalSubscribers } from '@/lib/kit-data'

export type SubscriberCountFormat = 'rounded' | 'exact'

export type SubscriberCountProps = {
	/** Rendered when the live count is unavailable (Kit not configured / API error). */
	fallback?: string
	/**
	 * 'rounded' (default) floors to the nearest thousand and appends '+'
	 * (72,405 → "72,000+") so copy like "Join over …" stays truthful.
	 * 'exact' renders the precise localized number (72,405 → "72,405").
	 */
	format?: SubscriberCountFormat
}

/**
 * Format a raw subscriber total for display.
 */
export function formatSubscriberCount(
	total: number,
	format: SubscriberCountFormat = 'rounded',
): string {
	if (format === 'exact') return total.toLocaleString('en-US')
	const rounded = Math.floor(total / 1000) * 1000
	if (rounded < 1000) return total.toLocaleString('en-US')
	return `${rounded.toLocaleString('en-US')}+`
}

/**
 * Live newsletter subscriber count, server-fetched from Kit (ConvertKit v4)
 * via [[src/lib/kit-data.ts#getTotalSubscribers]] and cached 30 min.
 *
 * Async server component — safe in server-compiled MDX (registered in the
 * inline `compile-mdx.tsx` map) and anywhere in a server tree:
 *
 *   Join over <SubscriberCount /> Developers Becoming AI Heroes
 *
 * Renders `fallback` ("90,000+" by default — list size per Matt, 2026-07-14)
 * when the live count is unavailable, per the upstream requirement that the
 * number is dynamically generated, never hardcoded.
 */
export async function SubscriberCount({
	fallback = '90,000+',
	format = 'rounded',
}: SubscriberCountProps) {
	const total = await getTotalSubscribers()
	if (total === null) return <>{fallback}</>
	return <>{formatSubscriberCount(total, format)}</>
}

/**
 * The primary newsletter CTA title with the LIVE subscriber count. Server
 * component — pass it from server call sites as
 * `<PrimaryNewsletterCta title={<PrimaryNewsletterTitle />} />` (the CTA is
 * a client component and can't fetch the count itself; its string default is
 * the static fallback for client-only call sites).
 */
export function PrimaryNewsletterTitle() {
	return (
		<>
			Join over <SubscriberCount /> Developers Becoming AI Heroes
		</>
	)
}
