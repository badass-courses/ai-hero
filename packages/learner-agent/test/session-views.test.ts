import { describe, expect, it } from 'vitest'

import type { SessionExtract } from '../src/session-extract.js'
import {
	chapterOverlaps,
	extractChapters,
	extractMoments,
	skillKey,
} from '../src/session-views.js'
import { BASE, lessonTwoExtract } from './fakes.js'

const links = new Map([['tdd', `${BASE}/skills-tdd`]])

describe('session moments', () => {
	it('lists only what Matt typed, in order, with its second', () => {
		expect(extractMoments(lessonTwoExtract, ['prompt'])).toEqual([
			{
				kind: 'prompt',
				sessionId: 's2',
				visibleFrom: 5,
				text: 'Refactor the refund module',
			},
			{
				kind: 'prompt',
				sessionId: 's2',
				visibleFrom: 32,
				text: 'Use parseRefund instead',
			},
		])
	})

	it('pairs each interrupt with the prompt Matt typed next', () => {
		expect(extractMoments(lessonTwoExtract, ['correction'])).toEqual([
			{
				kind: 'correction',
				sessionId: 's2',
				visibleFrom: 30,
				interrupt: 'Stop',
				followedBy: { visibleFrom: 32, text: 'Use parseRefund instead' },
			},
		])
	})

	it('lists skill calls with their args, linked when AI Hero has a page', () => {
		expect(extractMoments(lessonTwoExtract, ['skill'], links)).toEqual([
			{
				kind: 'skill',
				sessionId: 's2',
				visibleFrom: 8,
				skill: 'tdd',
				via: 'slashCommand',
				args: 'refund flow',
				skillUrl: `${BASE}/skills-tdd`,
			},
			{
				kind: 'skill',
				sessionId: 's2',
				visibleFrom: 40,
				skill: 'grill-me',
				via: 'toolCall',
				args: null,
				skillUrl: null,
			},
		])
	})

	it('pairs a failed tool call with the next prompt or reply', () => {
		expect(extractMoments(lessonTwoExtract, ['error'])).toEqual([
			{
				kind: 'error',
				sessionId: 's2',
				visibleFrom: 15,
				tool: 'Bash',
				summary: 'pnpm test',
				recovery: {
					kind: 'assistantText',
					visibleFrom: 18,
					text: 'One test fails',
				},
			},
		])
	})

	it('leaves the pair empty when nothing follows, and never crosses sessions', () => {
		const extract: SessionExtract = {
			sessions: [
				{
					sessionId: 'a',
					entries: [
						{ kind: 'interrupt', visibleFrom: 1, text: 'Wait' },
						{
							kind: 'toolCall',
							visibleFrom: 2,
							tool: 'Edit',
							summary: null,
							resultIsError: true,
						},
					],
				},
				{
					sessionId: 'b',
					entries: [{ kind: 'userPrompt', visibleFrom: 3, text: 'Next' }],
				},
			],
		}
		const [correction, error] = extractMoments(extract, ['correction', 'error'])
		expect(correction).toMatchObject({ kind: 'correction', followedBy: null })
		expect(error).toMatchObject({ kind: 'error', recovery: null })
	})

	it('skips tool calls that did not fail or whose result is unknown', () => {
		const extract: SessionExtract = {
			sessions: [
				{
					sessionId: 'a',
					entries: [
						{
							kind: 'toolCall',
							visibleFrom: 1,
							tool: 'Read',
							summary: null,
							resultIsError: false,
						},
						{
							kind: 'toolCall',
							visibleFrom: 2,
							tool: 'Read',
							summary: null,
							resultIsError: null,
						},
					],
				},
			],
		}
		expect(extractMoments(extract, ['error'])).toEqual([])
	})

	it('adds no words of its own: every text is an entry’s text', () => {
		const texts = new Set(
			lessonTwoExtract.sessions.flatMap((session) =>
				session.entries.flatMap((entry) =>
					'text' in entry ? [entry.text] : [],
				),
			),
		)
		for (const moment of extractMoments(
			lessonTwoExtract,
			['prompt', 'correction', 'error'],
			links,
		)) {
			const said = [
				'text' in moment ? moment.text : null,
				'interrupt' in moment ? moment.interrupt : null,
				'followedBy' in moment ? moment.followedBy?.text : null,
				'recovery' in moment ? moment.recovery?.text : null,
			].filter((text): text is string => typeof text === 'string')
			for (const text of said) expect(texts.has(text)).toBe(true)
		}
	})
})

describe('session chapters', () => {
	it('splits each session at every prompt, ending where the next begins', () => {
		const chapters = extractChapters(lessonTwoExtract)
		expect(
			chapters.map(({ index, startsAt, endsAt, prompt, entries }) => ({
				index,
				startsAt,
				endsAt,
				prompt,
				entries: entries.length,
			})),
		).toEqual([
			{
				index: 0,
				startsAt: 5,
				endsAt: 32,
				prompt: 'Refactor the refund module',
				entries: 6,
			},
			{
				index: 1,
				startsAt: 32,
				endsAt: null,
				prompt: 'Use parseRefund instead',
				entries: 2,
			},
		])
	})

	it('keeps entries before the first prompt as a chapter with no prompt', () => {
		const [first] = extractChapters({
			sessions: [
				{
					sessionId: 'a',
					entries: [
						{ kind: 'assistantText', visibleFrom: 2, text: 'Resuming' },
						{ kind: 'userPrompt', visibleFrom: 4, text: 'Go on' },
					],
				},
			],
		})
		expect(first).toMatchObject({ prompt: null, startsAt: 2, endsAt: 4 })
	})

	it('overlaps a window when any part of the chapter falls inside it', () => {
		const [first, second] = extractChapters(lessonTwoExtract)
		expect(chapterOverlaps(first!, 0, 4)).toBe(false)
		expect(chapterOverlaps(first!, 20, 25)).toBe(true)
		expect(chapterOverlaps(second!, 1000, 2000)).toBe(true)
	})
})

describe('skill names', () => {
	it('matches with or without the slash, in any case', () => {
		expect(skillKey(' /TDD ')).toBe('tdd')
		expect(skillKey('grill-me')).toBe('grill-me')
	})
})

describe('the views entry point', () => {
	it('imports nothing, so a client bundle gets no Effect', async () => {
		const { readFile } = await import('node:fs/promises')
		const source = await readFile(
			new URL('../src/views.ts', import.meta.url),
			'utf8',
		)
		expect(source).not.toMatch(/^\s*(import|export .* from)\b/m)
	})
})
