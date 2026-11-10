'use server'

import { cache } from 'react'
import { cookies } from 'next/headers'
import {
	createSubscriberGateSnapshot,
	mergeSubscriberGateSnapshot,
	parseSubscriberGateSnapshot,
	SUBSCRIBER_GATE_COOKIE,
} from '@/lib/cta/subscriber-gate-cookie'
import { readKitSubscriberIdentity } from '@/lib/kit-subscriber-directory'
import { SubscriberSchema } from '@/schemas/subscriber'

/**
 * Sets the subscriber cookies after a successful survey submission or subscriber fetch
 */
export async function setSubscriberCookie(subscriber: {
	id: number | string
	[key: string]: any
}) {
	const cookieStore = await cookies()

	cookieStore.set('ck_subscriber', JSON.stringify(deepOmitNull(subscriber)), {
		secure: process.env.NODE_ENV === 'production',
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 31556952, // 1 year
	})

	cookieStore.set('ck_subscriber_id', JSON.stringify(subscriber.id), {
		secure: process.env.NODE_ENV === 'production',
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 31556952, // 1 year
	})

	const subscriberId = Number(subscriber.id)
	if (Number.isFinite(subscriberId)) {
		cookieStore.set(
			SUBSCRIBER_GATE_COOKIE,
			JSON.stringify(
				createSubscriberGateSnapshot({ ...subscriber, id: subscriberId }),
			),
			{
				secure: process.env.NODE_ENV === 'production',
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				maxAge: 31556952,
			},
		)
	}
}

/**
 * Sets the ck_subscriber_id cookie from a URL parameter
 * Used when users click email links with ?ck_subscriber_id=X
 */
export async function setSubscriberIdFromUrl(subscriberId: string) {
	const normalizedSubscriberId = subscriberId.trim().slice(0, 255)
	if (!normalizedSubscriberId) return
	const cookieStore = await cookies()

	cookieStore.set('ck_subscriber_id', normalizedSubscriberId, {
		secure: process.env.NODE_ENV === 'production',
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 31556952, // 1 year
	})
}

/**
 * Gets the subscriber from cookies, resolving a bare Kit id through the local
 * contact directory (never Kit). The directory answers identity only, so list
 * state and fields come from the reader's own gate snapshot.
 */
export const getSubscriberFromCookie = cache(async () => {
	const cookieStore = await cookies()
	if (!cookieStore) return null

	const cookie = cookieStore.get('ck_subscriber')?.value
	const subscriberIdCookie = cookieStore.get('ck_subscriber_id')?.value
	const gate = parseSubscriberGateSnapshot(
		cookieStore.get(SUBSCRIBER_GATE_COOKIE)?.value,
	)

	// If we have the full subscriber cookie, use that
	if (cookie && cookie !== 'undefined') {
		try {
			const subscriber = JSON.parse(cookie)
			if (subscriber?.id && !subscriber.email_address) {
				const identity = await readKitSubscriberIdentity(subscriber.id)
				if (!identity) return null
				return SubscriberSchema.parse(
					mergeSubscriberGateSnapshot(
						{ ...subscriber, ...identity },
						gate,
						'subscriber',
					),
				)
			}
			if (!subscriber?.id) throw new Error('no subscriber id')
			return SubscriberSchema.parse(
				mergeSubscriberGateSnapshot(subscriber, gate),
			)
		} catch (e) {
			return null
		}
	}

	// If we only have the ID (from a broadcast or signed link), resolve it and
	// populate the full subscriber cookie.
	if (subscriberIdCookie) {
		try {
			const identity = await readKitSubscriberIdentity(subscriberIdCookie)
			if (identity) {
				// Merged before it is written: the directory has no state or fields,
				// and writing it bare would blank the gate cookie's answers.
				const subscriber = mergeSubscriberGateSnapshot(
					identity,
					gate,
					'subscriber',
				)
				try {
					// Populate the full ck_subscriber cookie for future requests.
					// Cookie writes are only legal in actions/route handlers — during
					// an RSC render this throws, and the subscriber must still resolve.
					await setSubscriberCookie(subscriber)
				} catch {}
				return SubscriberSchema.parse(subscriber)
			}
		} catch (e) {
			return null
		}
	}

	return null
})

function deepOmitNull(obj: any): any {
	if (Array.isArray(obj)) {
		return obj.map(deepOmitNull).filter((x) => x !== null)
	}

	if (obj && typeof obj === 'object') {
		return Object.entries(obj).reduce(
			(acc, [key, value]) => {
				const cleaned = deepOmitNull(value)
				if (cleaned !== null) {
					acc[key] = cleaned
				}
				return acc
			},
			{} as Record<string, any>,
		)
	}

	return obj === null ? undefined : obj
}
