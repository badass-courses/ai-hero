import { NextRequest, NextResponse } from 'next/server'
import {
	addAttendeeFor,
	CalendarError,
	listAttendeesFor,
	removeAttendeeFor,
} from '@/lib/cms/calendar-attendees-service'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

/** Map a thrown error to a JSON response (typed `CalendarError` → its status, else 500). */
async function errorResponse(scope: string, error: unknown) {
	if (error instanceof CalendarError) {
		await log.error(`api.calendar.attendees.${scope}.error`, {
			error: error.message,
			details: error.details,
			statusCode: error.statusCode,
		})
		return NextResponse.json(
			{ error: error.message, details: error.details },
			{ status: error.statusCode, headers: corsHeaders },
		)
	}
	await log.error(`api.calendar.attendees.${scope}.failed`, {
		error: error instanceof Error ? error.message : 'Unknown error',
		stack: error instanceof Error ? error.stack : undefined,
	})
	return NextResponse.json(
		{ error: 'Internal server error' },
		{ status: 500, headers: corsHeaders },
	)
}

/**
 * GET /api/calendar/attendees?slugOrId=<event slug or id>
 *
 * List the current Google Calendar attendees for an event. Read-only. 409 if the
 * event exists but hasn't been synced to Google yet (no `calendarId`).
 */
export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url)
	const slugOrId = searchParams.get('slugOrId')
	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}
		// Check the permission BEFORE resolving the resource, so a caller who lacks
		// access can't tell an existing private event (403) from a missing one (404).
		if (ability.cannot('update', 'Content')) {
			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: corsHeaders },
			)
		}
		if (!slugOrId) {
			return NextResponse.json(
				{ error: 'Missing slugOrId parameter' },
				{ status: 400, headers: corsHeaders },
			)
		}

		await log.info('api.calendar.attendees.get.started', {
			userId: user.id,
			slugOrId,
		})

		const attendees = await listAttendeesFor({ slugOrId, ability })

		await log.info('api.calendar.attendees.get.success', {
			userId: user.id,
			slugOrId,
			resultCount: attendees.length,
		})

		return NextResponse.json(attendees, { headers: corsHeaders })
	} catch (error) {
		return errorResponse('get', error)
	}
}

/**
 * POST /api/calendar/attendees — add a person to an event's guest list.
 *
 * Body: { slugOrId, email }
 *
 * Adds the email as an attendee; Google emails them a calendar invite. 409 if the
 * email is already an attendee; 409 if the event isn't synced to Google yet.
 */
export async function POST(request: NextRequest) {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}
		// Permission check before resolving the resource (avoid a 403-vs-404 existence leak).
		if (ability.cannot('update', 'Content')) {
			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const body = await request.json().catch(() => null)
		const slugOrId = body?.slugOrId
		const email = body?.email
		if (typeof slugOrId !== 'string' || typeof email !== 'string') {
			return NextResponse.json(
				{ error: 'slugOrId and email (both strings) are required' },
				{ status: 400, headers: corsHeaders },
			)
		}

		await log.info('api.calendar.attendees.post.started', {
			userId: user.id,
			slugOrId,
		})

		const result = await addAttendeeFor({ slugOrId, email, ability })

		await log.info('api.calendar.attendees.post.success', {
			userId: user.id,
			slugOrId,
			email: result.email,
		})

		return NextResponse.json(result, { status: 201, headers: corsHeaders })
	} catch (error) {
		return errorResponse('post', error)
	}
}

/**
 * DELETE /api/calendar/attendees — remove a person from an event's guest list.
 *
 * Body: { slugOrId, email }
 *
 * Idempotent: removing someone not on the list succeeds with `removed: false`.
 */
export async function DELETE(request: NextRequest) {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}
		// Permission check before resolving the resource (avoid a 403-vs-404 existence leak).
		if (ability.cannot('update', 'Content')) {
			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const body = await request.json().catch(() => null)
		const slugOrId = body?.slugOrId
		const email = body?.email
		if (typeof slugOrId !== 'string' || typeof email !== 'string') {
			return NextResponse.json(
				{ error: 'slugOrId and email (both strings) are required' },
				{ status: 400, headers: corsHeaders },
			)
		}

		await log.info('api.calendar.attendees.delete.started', {
			userId: user.id,
			slugOrId,
		})

		const result = await removeAttendeeFor({ slugOrId, email, ability })

		await log.info('api.calendar.attendees.delete.success', {
			userId: user.id,
			slugOrId,
			email: result.email,
			removed: result.removed,
		})

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		return errorResponse('delete', error)
	}
}
