import { db } from '@/db'
import { contentResource } from '@/db/schema'
import {
	addUserToGoogleCalendarEvent,
	getGoogleCalendarEventAttendees,
	removeUserFromGoogleCalendarEvent,
} from '@/lib/google-calendar'
import { log } from '@/server/logger'
import { eq, sql } from 'drizzle-orm'

import type { Ability } from '@casl/ability'

/**
 * Actor-parameterized CORE of the calendar-attendee surface, mirroring
 * `attached-emails-service.ts`.
 *
 * Both the CMS UI (session-driven server actions) and the agent-facing HTTP
 * routes (`app/api/calendar/attendees`, device-token-driven) delegate here so the
 * two callers can never diverge on who may edit a guest list or what add/remove
 * does. Auth is passed in as a CASL `ability` instead of read from a session.
 *
 * Everything wraps the existing `google-calendar.ts` helpers, which operate on the
 * impersonated host's `primary` calendar. The add/remove helpers patch with
 * `sendUpdates: 'all'`, so Google emails the affected guest a real calendar
 * invite (on add) or cancellation (on remove).
 */

/** Shared error for the calendar-attendees surface (mirrors `EmailError`). `statusCode` maps to the HTTP status the route returns. */
export class CalendarError extends Error {
	constructor(
		message: string,
		public statusCode: number = 400,
		public details?: unknown,
	) {
		super(message)
	}
}

/** An attendee on a Google Calendar event (the shape `getGoogleCalendarEventAttendees` returns). */
export type CalendarAttendee = {
	email: string
	displayName?: string
	responseStatus?: string
}

/** Attendee management is gated on the same `update Content` ability as the emails API family. */
function assertCanManageContent(ability: Ability) {
	if (ability.cannot('update', 'Content')) {
		throw new CalendarError('Unauthorized', 403)
	}
}

// Deliberately permissive; Google validates the address on write. This only
// rejects obviously-malformed input so we never patch the calendar with garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeEmail(raw: unknown): string {
	const email = typeof raw === 'string' ? raw.trim() : ''
	if (!EMAIL_RE.test(email)) {
		throw new CalendarError('a valid email is required', 400)
	}
	return email
}

/**
 * Resolve a slug OR id to the Google Calendar event id stored on the event
 * resource's `fields.calendarId`. Mirrors the emails service's
 * `resolveResourceIdFromSlugOrId` (id-first, then slug) but is inlined here to keep
 * the calendar surface decoupled from the email send module's import graph.
 *
 * - 404 if no resource matches the slug/id.
 * - 409 if the resource exists but has not been synced to Google yet (no
 *   `calendarId`), so a caller knows to wait for `calendarSync` rather than retry.
 */
export async function resolveCalendarEventIdFromSlugOrId(
	slugOrId: string,
): Promise<string> {
	// id-first so an exact id always wins over a different row whose slug collides
	// with this id; then fall back to a slug match (`->>` = JSON_UNQUOTE).
	const byId = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, slugOrId),
	})
	const resource =
		byId ??
		(await db.query.contentResource.findFirst({
			where: eq(sql`${contentResource.fields}->>'$.slug'`, slugOrId),
		}))

	if (!resource) {
		throw new CalendarError('Resource not found', 404)
	}
	// Only events carry a Google calendar entry. Reject a non-event resource
	// outright rather than falling through to the 409 "not synced yet", which
	// would wrongly imply a sync is pending for something that never syncs.
	if (resource.type !== 'event') {
		throw new CalendarError('Resource is not a calendar event', 404)
	}

	const fields = (resource.fields ?? {}) as Record<string, unknown>
	const calendarId =
		typeof fields.calendarId === 'string' && fields.calendarId
			? fields.calendarId
			: null
	if (!calendarId) {
		throw new CalendarError(
			'Event has not been synced to Google Calendar yet',
			409,
		)
	}
	return calendarId
}

/**
 * Fetch attendees for a resolved Google event, distinguishing a genuinely empty
 * guest list (`[]`) from a DELETED backing event. `getGoogleCalendarEventAttendees`
 * returns `null` on a 404 — which happens when `fields.calendarId` is stale (the
 * Google event was deleted). Collapsing that to `[]` would silently mask the
 * broken sync, so we surface it as 410 Gone instead.
 */
async function attendeesOrThrow(
	calendarEventId: string,
): Promise<CalendarAttendee[]> {
	const attendees = await getGoogleCalendarEventAttendees(calendarEventId)
	if (attendees === null) {
		throw new CalendarError(
			'The Google Calendar event no longer exists (it may have been deleted). Re-save the event to recreate it.',
			410,
		)
	}
	return attendees
}

/** List the current Google Calendar attendees for an event (by slug or id). Read-only. */
export async function listAttendeesFor({
	slugOrId,
	ability,
}: {
	slugOrId: string
	ability: Ability
}): Promise<CalendarAttendee[]> {
	assertCanManageContent(ability)
	const calendarEventId = await resolveCalendarEventIdFromSlugOrId(slugOrId)
	return attendeesOrThrow(calendarEventId)
}

/**
 * Add an arbitrary person (by email) to an event's Google Calendar guest list.
 *
 * The raw helper pushes without deduping, which would create a duplicate attendee
 * row in Google — so we check first and reject a repeat with 409 (matching the
 * emails API's "attach an already-attached email" semantics). Google emails the
 * guest a calendar invite.
 */
export async function addAttendeeFor({
	slugOrId,
	email,
	ability,
}: {
	slugOrId: string
	email: string
	ability: Ability
}): Promise<{ email: string; added: true }> {
	assertCanManageContent(ability)
	const cleanEmail = normalizeEmail(email)
	const calendarEventId = await resolveCalendarEventIdFromSlugOrId(slugOrId)

	const existing = await attendeesOrThrow(calendarEventId)
	if (
		existing.some((a) => a.email.toLowerCase() === cleanEmail.toLowerCase())
	) {
		throw new CalendarError('That email is already an attendee', 409)
	}

	// Manual add: notify the guest with a real calendar invite (unlike the silent
	// post-purchase add, which is why the helper defaults to no notification).
	await addUserToGoogleCalendarEvent(calendarEventId, cleanEmail, {
		sendUpdates: 'all',
	})
	// Don't log the raw attendee email (PII) — calendarEventId is enough to
	// correlate the operation.
	void log.info('calendar.attendees.service.added', {
		calendarEventId,
	})
	return { email: cleanEmail, added: true }
}

/**
 * Remove a person (by email) from an event's Google Calendar guest list.
 *
 * Idempotent: removing someone who isn't on the list succeeds with
 * `removed: false`. We pass the exact stored casing to the helper (which matches
 * case-sensitively) so removal always takes effect regardless of input casing.
 */
export async function removeAttendeeFor({
	slugOrId,
	email,
	ability,
}: {
	slugOrId: string
	email: string
	ability: Ability
}): Promise<{ email: string; removed: boolean }> {
	assertCanManageContent(ability)
	const cleanEmail = normalizeEmail(email)
	const calendarEventId = await resolveCalendarEventIdFromSlugOrId(slugOrId)

	const before = await attendeesOrThrow(calendarEventId)
	const match = before.find(
		(a) => a.email.toLowerCase() === cleanEmail.toLowerCase(),
	)

	// Manual remove: notify the guest with a cancellation (unlike the silent
	// refund/sync removal, which is why the helper defaults to no notification).
	await removeUserFromGoogleCalendarEvent(
		calendarEventId,
		match?.email ?? cleanEmail,
		{ sendUpdates: 'all' },
	)
	// Don't log the raw attendee email (PII).
	void log.info('calendar.attendees.service.removed', {
		calendarEventId,
		wasPresent: Boolean(match),
	})
	return { email: cleanEmail, removed: Boolean(match) }
}
