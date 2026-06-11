import type { VideoChapter } from '@coursebuilder/core/schemas'

export function formatSeconds(totalSeconds: number): string {
	const safe = Math.max(0, Math.floor(totalSeconds))
	const hours = Math.floor(safe / 3600)
	const minutes = Math.floor((safe % 3600) / 60)
	const seconds = safe % 60
	const pad = (n: number) => n.toString().padStart(2, '0')

	if (hours > 0) {
		return `${hours}:${pad(minutes)}:${pad(seconds)}`
	}
	return `${minutes}:${pad(seconds)}`
}

export function parseTimecode(input: string): number | null {
	if (typeof input !== 'string') return null
	const trimmed = input.trim()
	if (!trimmed) return null

	const match = trimmed.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/)
	if (!match) return null

	const a = parseInt(match[1]!, 10)
	const b = parseInt(match[2]!, 10)
	const c = match[3] !== undefined ? parseInt(match[3], 10) : null

	if (c === null) {
		if (b >= 60) return null
		return a * 60 + b
	}
	if (b >= 60 || c >= 60) return null
	return a * 3600 + b * 60 + c
}

export function sortByStartTime(chapters: VideoChapter[]): VideoChapter[] {
	return [...chapters].sort((a, b) => a.startTime - b.startTime)
}

export function hasDuplicateStartTimes(chapters: VideoChapter[]): boolean {
	const seen = new Set<number>()
	for (const c of chapters) {
		if (seen.has(c.startTime)) return true
		seen.add(c.startTime)
	}
	return false
}

export type ChapterValidationError =
	| { kind: 'duplicate-startTime'; startTime: number }
	| { kind: 'startTime-exceeds-duration'; startTime: number; duration: number }
	| { kind: 'empty-title'; index: number }

export function validateChapters(
	chapters: VideoChapter[],
	videoDuration?: number | null,
): ChapterValidationError | null {
	const sorted = sortByStartTime(chapters)
	for (let i = 0; i < sorted.length; i++) {
		if (!sorted[i]!.title.trim()) {
			return { kind: 'empty-title', index: i }
		}
		if (i > 0 && sorted[i]!.startTime === sorted[i - 1]!.startTime) {
			return { kind: 'duplicate-startTime', startTime: sorted[i]!.startTime }
		}
	}
	if (typeof videoDuration === 'number' && videoDuration > 0) {
		const overflow = sorted.find((c) => c.startTime > videoDuration)
		if (overflow) {
			return {
				kind: 'startTime-exceeds-duration',
				startTime: overflow.startTime,
				duration: videoDuration,
			}
		}
	}
	return null
}

const YOUTUBE_LINE_REGEX = /^(\d{1,2}(?::\d{1,2}){1,2})\s+(.+)$/

export interface ParseYoutubeResult {
	chapters: VideoChapter[]
	skippedLines: string[]
}

export function parseYoutubeChaptersText(text: string): ParseYoutubeResult {
	const chapters: VideoChapter[] = []
	const skippedLines: string[] = []

	if (typeof text !== 'string' || !text.trim()) {
		return { chapters, skippedLines }
	}

	const lines = text.split(/\r?\n/)
	for (const rawLine of lines) {
		const line = rawLine.trim()
		if (!line) continue

		const match = line.match(YOUTUBE_LINE_REGEX)
		if (!match) {
			skippedLines.push(rawLine)
			continue
		}

		const startTime = parseTimecode(match[1]!)
		const title = match[2]!.trim()
		if (startTime === null || !title) {
			skippedLines.push(rawLine)
			continue
		}

		chapters.push({ startTime, title })
	}

	return { chapters, skippedLines }
}

export function toYoutubeChaptersText(chapters: VideoChapter[]): string {
	return sortByStartTime(chapters)
		.map((c) => `${formatSeconds(c.startTime)} ${c.title}`)
		.join('\n')
}

export function toMuxChapters(
	chapters: VideoChapter[],
): { startTime: number; value: string }[] {
	return chapters.map((c) => ({ startTime: c.startTime, value: c.title }))
}
