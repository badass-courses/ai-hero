import { describe, expect, it } from 'vitest'

import {
	activeRowIndex,
	contentWords,
	parseSessionExtract,
	rowsOnScreen,
	sessionExtractRows,
	spokenBlockIndex,
	type SessionExtract,
} from './session-extract'

const extract: SessionExtract = {
	sessions: [
		{
			sessionId: 'a',
			entries: [
				{ kind: 'userPrompt', visibleFrom: 2, text: '/grill-me' },
				{
					kind: 'skillCall',
					via: 'slashCommand',
					visibleFrom: 2,
					skill: 'grill-me',
					args: null,
					skillBody: 'Ask one question at a time.',
				},
				{
					kind: 'toolCall',
					visibleFrom: 5,
					tool: 'Read',
					summary: 'docs/glossary.md',
					resultIsError: false,
				},
				{
					kind: 'toolCall',
					visibleFrom: 6,
					tool: 'Bash',
					summary: 'List tickets',
					resultIsError: null,
				},
				{ kind: 'assistantText', visibleFrom: 9, text: 'First question.' },
			],
		},
		{
			sessionId: 'b',
			entries: [{ kind: 'userPrompt', visibleFrom: 8, text: 'Next ticket' }],
		},
	],
}

describe('parseSessionExtract', () => {
	it('accepts an extract', () => {
		expect(parseSessionExtract(extract).status).toBe('available')
	})

	it('accepts the stored JSON string form', () => {
		expect(parseSessionExtract(JSON.stringify(extract)).status).toBe(
			'available',
		)
	})

	it('reads keys the producer omits as null', () => {
		const parsed = parseSessionExtract({
			sessions: [
				{
					sessionId: 'a',
					entries: [
						{
							kind: 'skillCall',
							via: 'toolCall',
							visibleFrom: 2,
							skill: 'grill-me',
						},
						{
							kind: 'skillCall',
							via: 'slashCommand',
							visibleFrom: 3,
							skill: 'grill-me',
						},
						{ kind: 'toolCall', visibleFrom: 5, tool: 'Read' },
					],
				},
			],
		})
		expect(parsed.extract?.sessions[0]?.entries).toEqual([
			{
				kind: 'skillCall',
				via: 'toolCall',
				visibleFrom: 2,
				skill: 'grill-me',
				args: null,
				result: null,
				resultIsError: null,
				skillBody: null,
			},
			{
				kind: 'skillCall',
				via: 'slashCommand',
				visibleFrom: 3,
				skill: 'grill-me',
				args: null,
				skillBody: null,
			},
			{
				kind: 'toolCall',
				visibleFrom: 5,
				tool: 'Read',
				summary: null,
				resultIsError: null,
			},
		])
	})

	it('reports a missing extract', () => {
		expect(parseSessionExtract(undefined).status).toBe('missing')
		expect(parseSessionExtract(null).status).toBe('missing')
	})

	it('reports a malformed extract as invalid instead of throwing', () => {
		expect(parseSessionExtract({ sessions: [] }).status).toBe('invalid')
		expect(parseSessionExtract('{not json').status).toBe('invalid')
		expect(
			parseSessionExtract({
				sessions: [
					{ sessionId: 'a', entries: [{ kind: 'userPrompt', text: 'x' }] },
				],
			}).status,
		).toBe('invalid')
	})
})

describe('sessionExtractRows', () => {
	const rows = sessionExtractRows(extract)

	it('collapses consecutive tool calls and marks later sessions', () => {
		expect(rows.map((row) => row.type)).toEqual([
			'entry',
			'entry',
			'tools',
			'entry',
			'sessionStart',
			'entry',
		])
		expect(rows[2]).toMatchObject({ type: 'tools', visibleFrom: 5 })
	})

	it('keeps times non-decreasing across sessions', () => {
		expect(rows.map((row) => row.visibleFrom)).toEqual([2, 2, 5, 9, 9, 9])
	})
})

describe('rowsOnScreen', () => {
	const rows = sessionExtractRows(extract)

	it('lists only the tool calls whose time has passed', () => {
		const at5 = rowsOnScreen(rows, 5)
		expect(at5).toHaveLength(3)
		expect(at5[2]).toMatchObject({
			type: 'tools',
			entries: [{ tool: 'Read' }],
		})
		expect(rowsOnScreen(rows, 6)[2]).toMatchObject({
			entries: [{ tool: 'Read' }, { tool: 'Bash' }],
		})
	})

	it('is empty before the first row', () => {
		expect(rowsOnScreen(rows, 1)).toEqual([])
	})
})

describe('activeRowIndex', () => {
	const rows = sessionExtractRows(extract)

	it('is -1 before the first row', () => {
		expect(activeRowIndex(rows, 1)).toBe(-1)
	})

	it('picks the last row whose time has passed', () => {
		expect(activeRowIndex(rows, 2)).toBe(1)
		expect(activeRowIndex(rows, 7)).toBe(2)
		expect(activeRowIndex(rows, 100)).toBe(5)
	})
})

describe('spokenBlockIndex', () => {
	const blocks = [
		'Q3 - Is web push in v1?: Through Knock it needs a Firebase project.',
		'Q4 - What happens to the refund emails Cadence already sends?: The "Refund approved/declined" email covers the same event.',
		'(b) Keep it as a direct transactional email outside the Notification system.',
	].map(contentWords)

	it('finds the block Matt reads out', () => {
		const spoken = contentWords(
			'Question four is asking, what happens to the refund emails cadence already sends?',
		)
		expect(spokenBlockIndex(spoken, blocks)).toBe(1)
	})

	it('ignores a single shared phrase while he riffs', () => {
		// 2:10 in Finish The Map: talking about the map, not option (b).
		const spoken = contentWords(
			"But for now, we're just gonna focus on getting everything into the notification system and extending it later. We will do email at some point.",
		)
		expect(spokenBlockIndex(spoken, blocks)).toBe(-1)
	})

	it('highlights nothing while he riffs', () => {
		const spoken = contentWords(
			"I think this is probably just too complicated, let's keep the scope small.",
		)
		expect(spokenBlockIndex(spoken, blocks)).toBe(-1)
	})
})
