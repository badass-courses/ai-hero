import {
	buildOfficeHoursGoogleCalendarDescription,
	buildOfficeHoursGoogleCalendarUrl,
	createYouTubeWatchUrl,
	formatOfficeHoursUtcTimeRange,
	getOfficeHoursCalendarTitle,
	groupOfficeHoursSessionsByUtcDate,
	isOfficeHoursSessionLive,
	isOfficeHoursSessionPast,
} from '@/lib/cohort-office-hours'
import { describe, expect, it } from 'vitest'

describe('cohort office hours helpers', () => {
	it('groups sessions by UTC date and keeps them sorted', () => {
		const groups = groupOfficeHoursSessionsByUtcDate([
			{
				title: 'Session 2',
				startsAt: '2026-04-03T15:30:00.000Z',
				endsAt: '2026-04-03T16:15:00.000Z',
				youtubeBroadcastId: 'broadcast-2',
				youtubeWatchUrl: createYouTubeWatchUrl('broadcast-2'),
			},
			{
				title: 'Session 1',
				startsAt: '2026-03-30T08:30:00.000Z',
				endsAt: '2026-03-30T09:15:00.000Z',
				youtubeBroadcastId: 'broadcast-1',
				youtubeWatchUrl: createYouTubeWatchUrl('broadcast-1'),
			},
			{
				title: 'Session 3',
				startsAt: '2026-04-03T08:30:00.000Z',
				endsAt: '2026-04-03T09:15:00.000Z',
				youtubeBroadcastId: 'broadcast-3',
				youtubeWatchUrl: createYouTubeWatchUrl('broadcast-3'),
			},
		])

		expect(groups).toHaveLength(2)
		expect(groups[0]?.label).toBe('Opening Monday')
		expect(
			groups[0]?.sessions.map((session) => session.youtubeBroadcastId),
		).toEqual(['broadcast-1'])
		expect(groups[1]?.label).toBe('Second Monday')
		expect(
			groups[1]?.sessions.map((session) => session.youtubeBroadcastId),
		).toEqual(['broadcast-3', 'broadcast-2'])
	})

	it('formats UTC time ranges clearly', () => {
		expect(
			formatOfficeHoursUtcTimeRange(
				'2026-03-30T08:30:00.000Z',
				'2026-03-30T09:15:00.000Z',
			),
		).toBe('08:30 to 09:15 UTC')
	})

	it('strips redundant date and time from calendar titles', () => {
		expect(
			getOfficeHoursCalendarTitle(
				'Claude Code for Real Engineers Office Hours, Mon Mar 30, 08:30 UTC',
			),
		).toBe('Claude Code for Real Engineers Office Hours')
	})

	it('builds a rich Google Calendar description for a session', () => {
		expect(
			buildOfficeHoursGoogleCalendarDescription({
				title:
					'Claude Code for Real Engineers Office Hours, Mon Mar 30, 08:30 UTC',
				startsAt: '2026-03-30T08:30:00.000Z',
				endsAt: '2026-03-30T09:15:00.000Z',
				youtubeBroadcastId: 'broadcast-1',
				youtubeWatchUrl: createYouTubeWatchUrl('broadcast-1'),
			}),
		).toContain('Live office hours for Claude Code for Real Engineers.')
	})

	it('detects past and live sessions', () => {
		const session = {
			startsAt: '2026-03-30T08:30:00.000Z',
			endsAt: '2026-03-30T09:15:00.000Z',
		}

		expect(
			isOfficeHoursSessionLive(session, new Date('2026-03-30T08:45:00.000Z')),
		).toBe(true)
		expect(
			isOfficeHoursSessionPast(session, new Date('2026-03-30T09:15:00.000Z')),
		).toBe(true)
		expect(
			isOfficeHoursSessionPast(session, new Date('2026-03-30T08:45:00.000Z')),
		).toBe(false)
	})

	it('builds a Google Calendar link for a session', () => {
		const url = new URL(
			buildOfficeHoursGoogleCalendarUrl({
				title:
					'Claude Code for Real Engineers Office Hours, Mon Mar 30, 08:30 UTC',
				startsAt: '2026-03-30T08:30:00.000Z',
				endsAt: '2026-03-30T09:15:00.000Z',
				youtubeBroadcastId: 'broadcast-1',
				youtubeWatchUrl: createYouTubeWatchUrl('broadcast-1'),
			}),
		)

		expect(url.origin + url.pathname).toBe(
			'https://calendar.google.com/calendar/render',
		)
		expect(url.searchParams.get('text')).toBe(
			'Claude Code for Real Engineers Office Hours',
		)
		expect(url.searchParams.get('dates')).toBe(
			'20260330T083000Z/20260330T091500Z',
		)
		expect(url.searchParams.get('details')).toContain(
			'Join live on YouTube to ask questions, get unstuck, and see the material in action.',
		)
		expect(url.searchParams.get('details')).toContain(
			createYouTubeWatchUrl('broadcast-1'),
		)
	})
})
