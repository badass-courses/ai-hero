'use server'

import { getServerAuthSession } from '@/server/auth'

import {
	addAttendeeFor,
	CalendarError,
	type CalendarAttendee,
	listAttendeesFor,
	removeAttendeeFor,
} from './calendar-attendees-service'

/**
 * SESSION-driven entry points for the CMS calendar-attendees panel, mirroring
 * `attached-emails-actions.ts`. The actual logic lives in the actor-parameterized
 * core (`calendar-attendees-service.ts`), which the agent-facing HTTP routes
 * (`app/api/calendar/attendees`) also call — so the CMS and the API can't diverge
 * on who may edit a guest list or what add/remove does.
 */

async function requireContentSession() {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}
	return { session, ability }
}

/**
 * The result shape returned to the client — a discriminated state so the panel can
 * render the right empty state rather than a bare list:
 * - `ready`: attendees loaded (possibly empty).
 * - `sync-pending`: the event has no `calendarId` yet (not synced to Google).
 * - `event-missing`: `calendarId` is stale — the backing Google event was deleted.
 */
export type CalendarAttendeesResult =
	| { kind: 'ready'; attendees: CalendarAttendee[] }
	| { kind: 'sync-pending' }
	| { kind: 'event-missing' }

/** List the current Google Calendar attendees for an event (by slug or id). */
export async function listEventCalendarAttendees(
	slugOrId: string,
): Promise<CalendarAttendeesResult> {
	const { ability } = await requireContentSession()
	try {
		const attendees = await listAttendeesFor({ slugOrId, ability })
		return { kind: 'ready', attendees }
	} catch (error) {
		if (error instanceof CalendarError) {
			// Not-yet-synced (409) and deleted-backing-event (410) are expected
			// states with their own empty-state UI, not failures to surface.
			if (error.statusCode === 409) return { kind: 'sync-pending' }
			if (error.statusCode === 410) return { kind: 'event-missing' }
		}
		throw error
	}
}

/**
 * Add a person to the event's guest list. Expected failures (invalid email,
 * duplicate, not-yet-synced) come back as `{ ok: false, error }` so the panel can
 * show the message — server-action errors are redacted to a generic string in
 * production, so we can't rely on a thrown message reaching the client.
 */
export async function addEventCalendarAttendee(
	slugOrId: string,
	email: string,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
	const { ability } = await requireContentSession()
	try {
		const result = await addAttendeeFor({ slugOrId, email, ability })
		return { ok: true, email: result.email }
	} catch (error) {
		if (error instanceof CalendarError) {
			return { ok: false, error: error.message }
		}
		throw error
	}
}

/** Remove a person from the event's guest list (idempotent). */
export async function removeEventCalendarAttendee(
	slugOrId: string,
	email: string,
): Promise<
	{ ok: true; email: string; removed: boolean } | { ok: false; error: string }
> {
	const { ability } = await requireContentSession()
	try {
		const result = await removeAttendeeFor({ slugOrId, email, ability })
		return { ok: true, email: result.email, removed: result.removed }
	} catch (error) {
		if (error instanceof CalendarError) {
			return { ok: false, error: error.message }
		}
		throw error
	}
}
