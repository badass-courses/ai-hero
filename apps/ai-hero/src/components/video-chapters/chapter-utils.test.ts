import { describe, expect, it } from 'vitest'

import {
	formatSeconds,
	hasDuplicateStartTimes,
	parseTimecode,
	parseYoutubeChaptersText,
	sortByStartTime,
	toMuxChapters,
	toYoutubeChaptersText,
	validateChapters,
} from './chapter-utils'

describe('formatSeconds', () => {
	it('formats 0 as 0:00', () => {
		expect(formatSeconds(0)).toBe('0:00')
	})
	it('formats sub-minute as 0:SS', () => {
		expect(formatSeconds(59)).toBe('0:59')
	})
	it('formats minutes as M:SS', () => {
		expect(formatSeconds(125)).toBe('2:05')
	})
	it('formats hours as H:MM:SS', () => {
		expect(formatSeconds(3725)).toBe('1:02:05')
	})
	it('floors fractional seconds', () => {
		expect(formatSeconds(125.9)).toBe('2:05')
	})
	it('clamps negatives to 0:00', () => {
		expect(formatSeconds(-10)).toBe('0:00')
	})
})

describe('parseTimecode', () => {
	it('parses M:SS', () => {
		expect(parseTimecode('2:05')).toBe(125)
	})
	it('parses MM:SS', () => {
		expect(parseTimecode('02:05')).toBe(125)
	})
	it('parses H:MM:SS', () => {
		expect(parseTimecode('1:02:05')).toBe(3725)
	})
	it('parses HH:MM:SS', () => {
		expect(parseTimecode('01:02:05')).toBe(3725)
	})
	it('returns null for invalid input', () => {
		expect(parseTimecode('invalid')).toBeNull()
	})
	it('returns null for empty string', () => {
		expect(parseTimecode('')).toBeNull()
	})
	it('returns null for whitespace', () => {
		expect(parseTimecode('   ')).toBeNull()
	})
	it('returns null when seconds >= 60 in M:SS', () => {
		expect(parseTimecode('2:60')).toBeNull()
	})
	it('returns null when minutes >= 60 in H:MM:SS', () => {
		expect(parseTimecode('1:60:00')).toBeNull()
	})
})

describe('sortByStartTime', () => {
	it('sorts ascending', () => {
		const result = sortByStartTime([
			{ startTime: 30, title: 'B' },
			{ startTime: 0, title: 'A' },
			{ startTime: 60, title: 'C' },
		])
		expect(result.map((c) => c.startTime)).toEqual([0, 30, 60])
	})
	it('does not mutate input', () => {
		const input = [
			{ startTime: 30, title: 'B' },
			{ startTime: 0, title: 'A' },
		]
		sortByStartTime(input)
		expect(input[0]!.startTime).toBe(30)
	})
})

describe('hasDuplicateStartTimes', () => {
	it('returns false for unique startTimes', () => {
		expect(
			hasDuplicateStartTimes([
				{ startTime: 0, title: 'A' },
				{ startTime: 30, title: 'B' },
			]),
		).toBe(false)
	})
	it('returns true for duplicates', () => {
		expect(
			hasDuplicateStartTimes([
				{ startTime: 0, title: 'A' },
				{ startTime: 0, title: 'B' },
			]),
		).toBe(true)
	})
	it('returns false for empty array', () => {
		expect(hasDuplicateStartTimes([])).toBe(false)
	})
})

describe('validateChapters', () => {
	it('returns null for valid chapters', () => {
		expect(
			validateChapters([
				{ startTime: 0, title: 'Intro' },
				{ startTime: 30, title: 'Body' },
			]),
		).toBeNull()
	})
	it('detects duplicate startTime', () => {
		const err = validateChapters([
			{ startTime: 0, title: 'A' },
			{ startTime: 0, title: 'B' },
		])
		expect(err).toEqual({ kind: 'duplicate-startTime', startTime: 0 })
	})
	it('detects empty title (post-trim)', () => {
		const err = validateChapters([{ startTime: 0, title: '   ' }])
		expect(err?.kind).toBe('empty-title')
	})
	it('detects startTime exceeding duration', () => {
		const err = validateChapters(
			[
				{ startTime: 0, title: 'A' },
				{ startTime: 500, title: 'B' },
			],
			120,
		)
		expect(err).toEqual({
			kind: 'startTime-exceeds-duration',
			startTime: 500,
			duration: 120,
		})
	})
	it('ignores duration when null/undefined', () => {
		expect(validateChapters([{ startTime: 500, title: 'A' }], null)).toBeNull()
		expect(
			validateChapters([{ startTime: 500, title: 'A' }], undefined),
		).toBeNull()
	})
	it('returns null for empty array', () => {
		expect(validateChapters([])).toBeNull()
	})
})

describe('parseYoutubeChaptersText', () => {
	it('parses standard YouTube block', () => {
		const result = parseYoutubeChaptersText(
			"0:00 Welcome and course introduction\n0:22 What you'll learn\n1:20 Building autonomous AI agents",
		)
		expect(result.chapters).toEqual([
			{ startTime: 0, title: 'Welcome and course introduction' },
			{ startTime: 22, title: "What you'll learn" },
			{ startTime: 80, title: 'Building autonomous AI agents' },
		])
		expect(result.skippedLines).toEqual([])
	})

	it('parses HH:MM:SS', () => {
		const result = parseYoutubeChaptersText('1:23:45 Final segment')
		expect(result.chapters).toEqual([
			{ startTime: 5025, title: 'Final segment' },
		])
	})

	it('returns empty for empty input', () => {
		expect(parseYoutubeChaptersText('').chapters).toEqual([])
	})

	it('returns empty for whitespace-only input', () => {
		expect(parseYoutubeChaptersText('   \n   ').chapters).toEqual([])
	})

	it('skips lines without a leading timestamp', () => {
		const result = parseYoutubeChaptersText('not a chapter line')
		expect(result.chapters).toEqual([])
		expect(result.skippedLines).toEqual(['not a chapter line'])
	})

	it('skips blank lines between chapters without failing', () => {
		const result = parseYoutubeChaptersText('0:00 Intro\n\n0:22 Section')
		expect(result.chapters).toHaveLength(2)
		expect(result.skippedLines).toEqual([])
	})

	it('preserves internal whitespace in titles', () => {
		const result = parseYoutubeChaptersText('0:00    Lots of   whitespace')
		expect(result.chapters).toEqual([
			{ startTime: 0, title: 'Lots of   whitespace' },
		])
	})

	it('mixes valid and invalid lines, reporting both', () => {
		const result = parseYoutubeChaptersText('0:00 Intro\ngarbage\n0:22 Section')
		expect(result.chapters).toHaveLength(2)
		expect(result.skippedLines).toEqual(['garbage'])
	})
})

describe('toYoutubeChaptersText', () => {
	it('emits Matt-style YouTube block', () => {
		expect(
			toYoutubeChaptersText([
				{ startTime: 0, title: 'Intro' },
				{ startTime: 5025, title: 'Final' },
			]),
		).toBe('0:00 Intro\n1:23:45 Final')
	})
	it('sorts before emitting', () => {
		expect(
			toYoutubeChaptersText([
				{ startTime: 30, title: 'B' },
				{ startTime: 0, title: 'A' },
			]),
		).toBe('0:00 A\n0:30 B')
	})
	it('returns empty string for empty array', () => {
		expect(toYoutubeChaptersText([])).toBe('')
	})
})

describe('toMuxChapters', () => {
	it('maps title → value', () => {
		expect(toMuxChapters([{ startTime: 0, title: 'Intro' }])).toEqual([
			{ startTime: 0, value: 'Intro' },
		])
	})
	it('preserves order', () => {
		expect(
			toMuxChapters([
				{ startTime: 5, title: 'A' },
				{ startTime: 30, title: 'B' },
			]),
		).toEqual([
			{ startTime: 5, value: 'A' },
			{ startTime: 30, value: 'B' },
		])
	})
	it('returns empty for empty input', () => {
		expect(toMuxChapters([])).toEqual([])
	})
})
