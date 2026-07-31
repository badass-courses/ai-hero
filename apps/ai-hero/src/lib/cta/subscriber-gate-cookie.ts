export const SUBSCRIBER_GATE_COOKIE = 'ck_subscriber_gate'

export type SubscriberGateSnapshot = {
	id: number
	state: string | null
	fields: Record<string, string>
}

/**
 * The full Kit subscriber can exceed a browser cookie's ~4 KB limit. Long-time
 * subscribers commonly have hundreds of custom fields, so browsers reject the
 * write and leave an older `ck_subscriber` value in place. Keep the tiny facts
 * CTA gating needs in a separate cookie that remains writable for those users.
 */
export function createSubscriberGateSnapshot(subscriber: {
	id: number | string
	state?: string | null
	fields?: Record<string, unknown> | null
}): SubscriberGateSnapshot {
	return {
		id: Number(subscriber.id),
		state: subscriber.state ?? null,
		fields: pickSubscriberGateFields(subscriber.fields),
	}
}

export function parseSubscriberGateSnapshot(
	value: string | undefined,
): SubscriberGateSnapshot | null {
	if (!value || value === 'undefined') return null
	try {
		const parsed = JSON.parse(value) as Partial<SubscriberGateSnapshot>
		if (typeof parsed.id !== 'number' || !Number.isFinite(parsed.id))
			return null
		if (parsed.state !== null && typeof parsed.state !== 'string') return null
		if (!parsed.fields || typeof parsed.fields !== 'object') return null
		return createSubscriberGateSnapshot({
			id: parsed.id,
			state: parsed.state,
			fields: parsed.fields,
		})
	} catch {
		return null
	}
}

export function mergeSubscriberGateSnapshot<
	T extends {
		id: number | string
		state?: string | null
		fields?: Record<string, unknown> | null
	},
>(
	subscriber: T,
	gate: SubscriberGateSnapshot | null,
	precedence: 'gate' | 'subscriber' = 'gate',
): T {
	if (!gate || gate.id !== Number(subscriber.id)) return subscriber
	if (precedence === 'subscriber') {
		return {
			...subscriber,
			state: subscriber.state ?? gate.state,
			// A fetched Kit record is authoritative, including an empty fields
			// object after a field was cleared. Falling back field-by-field would
			// resurrect stale completion facts from the year-long gate cookie.
			fields: subscriber.fields ?? gate.fields,
		}
	}
	return {
		...subscriber,
		state: gate.state ?? subscriber.state,
		fields: {
			...(subscriber.fields ?? {}),
			...gate.fields,
		},
	}
}

export function pickSubscriberGateFields(
	fields: Record<string, unknown> | null | undefined,
): Record<string, string> {
	if (!fields) return {}
	const picked: Record<string, string> = {}
	for (const [key, value] of Object.entries(fields)) {
		if (typeof value !== 'string' || value.length === 0) continue
		if (
			key === 'interest' ||
			key.startsWith('aih_course_') ||
			key.startsWith('waitlist_') ||
			key.startsWith('interest_')
		) {
			picked[key] = value
		}
	}
	return picked
}
