import {
	buildOfficeHoursGoogleCalendarDescription,
	buildOfficeHoursGoogleCalendarUrl,
	createYouTubeWatchUrl,
	formatOfficeHoursUtcTimeRange,
	getOfficeHoursCalendarTitle,
	groupOfficeHoursSessionsByDate,
	isOfficeHoursSessionLive,
	isOfficeHoursSessionPast,
} from '@/lib/cohort-office-hours'
import { describe, expect, it } from 'vitest'

describe('cohort office hours helpers', () => {
	it('groups sessions by UTC date and keeps them sorted', () => {
		const groups = groupOfficeHoursSessionsByDate([
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
		expect(groups[1]?.label).toBe('Final Friday')
		expect(
			groups[1]?.sessions.map((session) => session.youtubeBroadcastId),
		).toEqual(['broadcast-3', 'broadcast-2'])
	})

	it('labels C5 Monday, Friday, Friday groups from their UTC weekdays', () => {
		const sessions = ['2026-11-09', '2026-11-13', '2026-11-20'].flatMap(
			(date) =>
				['00:30', '15:30'].map((time) => ({
					title: 'Synthetic office hours',
					startsAt: `${date}T${time}:00.000Z`,
					endsAt: `${date}T${time === '00:30' ? '01:15' : '16:15'}:00.000Z`,
					youtubeBroadcastId: 'synthetic-broadcast',
					youtubeWatchUrl: createYouTubeWatchUrl('synthetic-broadcast'),
				})),
		)
		const groups = groupOfficeHoursSessionsByDate(sessions.reverse())
		expect(
			groups.map(({ dateKey, label, sessions }) => ({
				dateKey,
				label,
				count: sessions.length,
			})),
		).toEqual([
			{ dateKey: '2026-11-09', label: 'Opening Monday', count: 2 },
			{ dateKey: '2026-11-13', label: 'Friday', count: 2 },
			{ dateKey: '2026-11-20', label: 'Final Friday', count: 2 },
		])
	})

	it('uses actual weekdays for any number of groups, including a single opening day', () => {
		const sessions = [
			'2026-11-10',
			'2026-11-11',
			'2026-11-12',
			'2026-11-14',
		].map((date) => ({
			title: 'Synthetic office hours',
			startsAt: `${date}T00:30:00.000Z`,
			endsAt: `${date}T01:15:00.000Z`,
			youtubeBroadcastId: 'synthetic-broadcast',
			youtubeWatchUrl: createYouTubeWatchUrl('synthetic-broadcast'),
		}))
		expect(
			groupOfficeHoursSessionsByDate(sessions).map(({ label }) => label),
		).toEqual(['Opening Tuesday', 'Wednesday', 'Thursday', 'Final Saturday'])
		expect(
			groupOfficeHoursSessionsByDate(sessions.slice(0, 1))[0]?.label,
		).toBe('Opening Tuesday')
		expect(groupOfficeHoursSessionsByDate([])).toEqual([])
	})

	it('groups by the calendar day of the given zone', () => {
		const session = (startsAt: string) => ({
			title: 'Synthetic office hours',
			startsAt,
			endsAt: startsAt,
			youtubeBroadcastId: startsAt,
			youtubeWatchUrl: createYouTubeWatchUrl('synthetic-broadcast'),
		})
		const groups = groupOfficeHoursSessionsByDate(
			[session('2026-11-10T02:00:00.000Z'), session('2026-11-10T23:00:00.000Z')],
			'America/New_York',
		)
		expect(groups.map(({ dateKey, label }) => [dateKey, label])).toEqual([
			['2026-11-09', 'Opening Monday'],
			['2026-11-10', 'Final Tuesday'],
		])
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
