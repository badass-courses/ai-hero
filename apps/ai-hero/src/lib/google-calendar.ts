import { log } from '@/server/logger'
import { JWT } from 'google-auth-library'
import { calendar_v3, google } from 'googleapis'

import { env } from '../env.mjs'

const SCOPES = ['https://www.googleapis.com/auth/calendar.events']

function getCalendarErrorMessage(error: any) {
	return (
		error?.response?.data?.error?.message || error?.message || String(error)
	)
}

function getCalendarErrorCode(error: any) {
	return (
		error?.response?.data?.error?.code || error?.response?.status || error?.code
	)
}

function getEventStart(event: Partial<calendar_v3.Schema$Event>) {
	return event.start?.dateTime || event.start?.date || undefined
}

/**
 * Helper function to get authenticated JWT client for Google Calendar API
 */
function getAuthClient() {
	const rawCredentialsJson = env.GOOG_CREDENTIALS_JSON
	if (!rawCredentialsJson) {
		throw new Error('GOOG_CREDENTIALS_JSON not found in environment.')
	}

	let credentialsJson: string
	if (isBase64(rawCredentialsJson)) {
		try {
			credentialsJson = Buffer.from(rawCredentialsJson, 'base64').toString(
				'utf8',
			)
		} catch (error: any) {
			throw new Error(`Failed to decode Base64 credentials: ${error.message}`)
		}
	} else {
		credentialsJson = rawCredentialsJson
	}

	let credentials
	try {
		credentials = JSON.parse(credentialsJson)
	} catch (error: any) {
		throw new Error(
			`Failed to parse credentials JSON: ${error.message}. Ensure correct format.`,
		)
	}

	if (
		!credentials.client_email ||
		!credentials.private_key ||
		!credentials.project_id
	) {
		throw new Error(
			'Credentials JSON missing required fields (client_email, private_key, project_id).',
		)
	}

	if (!env.GOOG_CALENDAR_IMPERSONATE_USER) {
		throw new Error('GOOG_CALENDAR_IMPERSONATE_USER not configured.')
	}

	void log.debug('calendar.auth.client', {
		serviceAccountEmail: credentials.client_email,
		impersonatedUser: env.GOOG_CALENDAR_IMPERSONATE_USER,
	})

	return new JWT({
		email: credentials.client_email,
		key: credentials.private_key,
		scopes: SCOPES,
		subject: env.GOOG_CALENDAR_IMPERSONATE_USER,
	})
}

/**
 * Checks if a string is likely Base64 encoded
 */
function isBase64(str: string): boolean {
	if (!str || str.trim() === '') {
		return false
	}
	try {
		const buffer = Buffer.from(str, 'base64')
		return buffer.toString('base64') === str
	} catch (err) {
		return false
	}
}

/**
 * Creates an event on the impersonated user's primary Google Calendar.
 *
 * @param eventDetails - The event object to create.
 * @returns The created event object.
 */
export async function createGoogleCalendarEvent(
	eventDetails: calendar_v3.Schema$Event,
): Promise<calendar_v3.Schema$Event> {
	try {
		const authClient = getAuthClient()
		const calendar = google.calendar({ version: 'v3', auth: authClient })

		void log.info('calendar.create.start', {
			summary: eventDetails.summary ?? undefined,
			start: getEventStart(eventDetails),
		})

		const response = await calendar.events.insert({
			calendarId: 'primary',
			requestBody: eventDetails,
		})

		if (!response.data) {
			throw new Error('Google Calendar API returned no data for created event.')
		}

		void log.info('calendar.create.success', {
			eventId: response.data.id,
			summary: response.data.summary ?? eventDetails.summary ?? undefined,
		})
		return response.data
	} catch (error: any) {
		void log.error('calendar.create.error', {
			summary: eventDetails.summary ?? undefined,
			start: getEventStart(eventDetails),
			error: getCalendarErrorMessage(error),
			code: getCalendarErrorCode(error),
		})
		if (error.response?.data?.error) {
			throw new Error(
				`Google Calendar API Error (Create): ${error.response.data.error.message || 'Unknown API error'} (Code: ${error.response.data.error.code})`,
			)
		} else {
			throw new Error(`Failed to create calendar event: ${error.message}`)
		}
	}
}

/**
 * Updates an existing event on the impersonated user's primary Google Calendar.
 *
 * @param calendarEventId - The ID of the Google Calendar event to update.
 * @param eventDetails - The event fields to update.
 * @returns The updated event object, or null if the event was not found (404).
 */
export async function updateGoogleCalendarEvent(
	calendarEventId: string,
	eventDetails: Partial<calendar_v3.Schema$Event>,
): Promise<calendar_v3.Schema$Event | null> {
	if (!calendarEventId) {
		throw new Error('Missing calendarEventId for update.')
	}
	try {
		const authClient = getAuthClient()
		const calendar = google.calendar({ version: 'v3', auth: authClient })

		void log.info('calendar.update.start', {
			eventId: calendarEventId,
			summary: eventDetails.summary ?? undefined,
			start: getEventStart(eventDetails),
		})
		const response = await calendar.events.patch({
			calendarId: 'primary',
			eventId: calendarEventId,
			requestBody: eventDetails,
			sendNotifications: false,
		})

		if (!response.data) {
			void log.warn('calendar.update.empty', {
				eventId: calendarEventId,
			})
			return null
		}

		void log.info('calendar.update.success', {
			eventId: response.data.id,
			summary: response.data.summary ?? eventDetails.summary ?? undefined,
		})
		return response.data
	} catch (error: any) {
		if (error.code === 404 || error.response?.status === 404) {
			void log.warn('calendar.update.not-found', {
				eventId: calendarEventId,
			})
			return null
		}

		void log.error('calendar.update.error', {
			eventId: calendarEventId,
			summary: eventDetails.summary ?? undefined,
			start: getEventStart(eventDetails),
			error: getCalendarErrorMessage(error),
			code: getCalendarErrorCode(error),
		})
		if (error.response?.data?.error) {
			throw new Error(
				`Google Calendar API Error (Update): ${error.response.data.error.message || 'Unknown API error'} (Code: ${error.response.data.error.code})`,
			)
		} else {
			throw new Error(`Failed to update calendar event: ${error.message}`)
		}
	}
}

/**
 * Retrieves an event from the impersonated user's primary Google Calendar.
 *
 * @param calendarEventId - The ID of the Google Calendar event to retrieve.
 * @returns The event object or null if not found.
 */
export async function getGoogleCalendarEvent(
	calendarEventId: string,
): Promise<calendar_v3.Schema$Event | null> {
	if (!calendarEventId) {
		throw new Error('Missing calendarEventId for get.')
	}
	try {
		const authClient = getAuthClient()
		const calendar = google.calendar({ version: 'v3', auth: authClient })

		void log.debug('calendar.get.start', {
			eventId: calendarEventId,
		})
		const response = await calendar.events.get({
			calendarId: 'primary',
			eventId: calendarEventId,
		})

		void log.info('calendar.get.success', {
			eventId: response.data.id,
		})
		return response.data || null
	} catch (error: any) {
		if (error.code === 404 || error.response?.status === 404) {
			void log.warn('calendar.get.not-found', {
				eventId: calendarEventId,
			})
			return null
		}

		void log.error('calendar.get.error', {
			eventId: calendarEventId,
			error: getCalendarErrorMessage(error),
			code: getCalendarErrorCode(error),
		})
		if (error.response?.data?.error) {
			throw new Error(
				`Google Calendar API Error (Get): ${error.response.data.error.message || 'Unknown API error'} (Code: ${error.response.data.error.code})`,
			)
		} else {
			throw new Error(`Failed to get calendar event: ${error.message}`)
		}
	}
}

/**
 * Adds a user to a Google Calendar event as an attendee.
 *
 * @param calendarEventId - The ID of the Google Calendar event.
 * @param userEmail - The email of the user to add.
 * @returns The updated event object.
 */
export async function addUserToGoogleCalendarEvent(
	calendarEventId: string,
	userEmail: string,
) {
	const authClient = getAuthClient()
	const calendar = google.calendar({ version: 'v3', auth: authClient })

	const response = await calendar.events.get({
		calendarId: 'primary',
		eventId: calendarEventId,
	})

	const event = response.data

	if (!event) {
		throw new Error('Event not found')
	}

	if (!event.attendees) {
		event.attendees = []
	}

	event.attendees.push({
		email: userEmail,
	})

	return updateGoogleCalendarEvent(calendarEventId, event)
}

/**
 * Gets the list of attendees for a Google Calendar event
 *
 * @param calendarEventId - The ID of the Google Calendar event.
 * @returns Array of attendees or null if event not found.
 */
export async function getGoogleCalendarEventAttendees(
	calendarEventId: string,
): Promise<Array<{
	email: string
	displayName?: string
	responseStatus?: string
}> | null> {
	if (!calendarEventId) {
		throw new Error('Missing calendarEventId for getting attendees.')
	}

	try {
		const authClient = getAuthClient()
		const calendar = google.calendar({ version: 'v3', auth: authClient })

		void log.debug('calendar.attendees.get.start', {
			eventId: calendarEventId,
		})
		const response = await calendar.events.get({
			calendarId: 'primary',
			eventId: calendarEventId,
		})

		const event = response.data
		if (!event) {
			void log.warn('calendar.attendees.get.not-found', {
				eventId: calendarEventId,
			})
			return null
		}

		if (!event.attendees || event.attendees.length === 0) {
			void log.debug('calendar.attendees.get.empty', {
				eventId: calendarEventId,
			})
			return []
		}

		const attendees = event.attendees
			.map((attendee) => ({
				email: attendee.email || '',
				displayName: attendee.displayName || undefined,
				responseStatus: attendee.responseStatus || undefined,
			}))
			.filter((attendee) => attendee.email)

		void log.info('calendar.attendees.get.success', {
			eventId: calendarEventId,
			attendeeCount: attendees.length,
		})
		return attendees
	} catch (error: any) {
		if (error.code === 404 || error.response?.status === 404) {
			void log.warn('calendar.attendees.get.not-found', {
				eventId: calendarEventId,
			})
			return null
		}

		void log.error('calendar.attendees.get.error', {
			eventId: calendarEventId,
			error: getCalendarErrorMessage(error),
			code: getCalendarErrorCode(error),
		})
		if (error.response?.data?.error) {
			throw new Error(
				`Google Calendar API Error (Get Attendees): ${error.response.data.error.message || 'Unknown API error'} (Code: ${error.response.data.error.code})`,
			)
		} else {
			throw new Error(
				`Failed to get calendar event attendees: ${error.message}`,
			)
		}
	}
}

/**
 * Removes a user from a Google Calendar event.
 *
 * @param calendarEventId - The ID of the Google Calendar event.
 * @param userEmail - The email of the user to remove.
 * @returns The updated event object or null if event not found.
 */
export async function removeUserFromGoogleCalendarEvent(
	calendarEventId: string,
	userEmail: string,
) {
	const authClient = getAuthClient()
	const calendar = google.calendar({ version: 'v3', auth: authClient })

	const response = await calendar.events.get({
		calendarId: 'primary',
		eventId: calendarEventId,
	})

	const event = response.data

	if (!event) {
		void log.warn('calendar.attendees.remove.event-not-found', {
			eventId: calendarEventId,
			userEmail,
		})
		return null
	}

	if (!event.attendees) {
		void log.warn('calendar.attendees.remove.empty', {
			eventId: calendarEventId,
			userEmail,
		})
		return event
	}

	const initialAttendeesCount = event.attendees.length
	event.attendees = event.attendees.filter(
		(attendee) => attendee.email !== userEmail,
	)

	if (event.attendees.length === initialAttendeesCount) {
		void log.warn('calendar.attendees.remove.user-not-found', {
			eventId: calendarEventId,
			userEmail,
		})
	}

	return updateGoogleCalendarEvent(calendarEventId, {
		...event,
		attendees: event.attendees,
	})
}
