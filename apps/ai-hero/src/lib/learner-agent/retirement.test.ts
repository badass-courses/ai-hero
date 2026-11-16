import { describe, expect, it } from 'vitest'

import {
	answerRetiredToolCalls,
	learnerAgentStage,
	learnerSignInOpen,
	RETIREMENT_COPY,
	siteUrlForCall,
	withNoticeOnHttpBody,
	withNoticeOnToolResults,
} from './retirement'

const BASE = 'https://www.aihero.dev'

describe('learnerAgentStage', () => {
	it('is active with both flags off, and retired wins over notice', () => {
		expect(learnerAgentStage({ notice: false, retired: false })).toBe('active')
		expect(learnerAgentStage({ notice: true, retired: false })).toBe('notice')
		expect(learnerAgentStage({ notice: true, retired: true })).toBe('retired')
		expect(learnerAgentStage({ notice: false, retired: true })).toBe('retired')
	})

	it('closes new sign-ins from the notice stage on', () => {
		expect(learnerSignInOpen('active')).toBe(true)
		expect(learnerSignInOpen('notice')).toBe(false)
		expect(learnerSignInOpen('retired')).toBe(false)
	})
})

describe('siteUrlForCall', () => {
	it('points at the lesson page when the call names one', () => {
		expect(
			siteUrlForCall(`${BASE}/`, {
				workshop: 'feedback-loops',
				lesson: 'intro',
			}),
		).toBe(`${BASE}/workshops/feedback-loops/intro`)
		expect(siteUrlForCall(BASE, { workshop: 'feedback-loops' })).toBe(
			`${BASE}/workshops/feedback-loops`,
		)
	})

	it('falls back to the site for anything else, never echoing odd input', () => {
		expect(siteUrlForCall(BASE, undefined)).toBe(BASE)
		expect(siteUrlForCall(BASE, { query: 'tdd' })).toBe(BASE)
		expect(
			siteUrlForCall(BASE, { workshop: '../evil', lesson: '<script>' }),
		).toBe(BASE)
	})
})

describe('answerRetiredToolCalls', () => {
	it('answers a single tool call with the message and the lesson link', () => {
		const { answered, rest, batch } = answerRetiredToolCalls(
			{
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/call',
				params: {
					name: 'read_lesson',
					arguments: { workshop: 'feedback-loops', lesson: 'intro' },
				},
			},
			BASE,
		)
		expect(batch).toBe(false)
		expect(rest).toEqual([])
		expect(answered).toEqual([
			{
				jsonrpc: '2.0',
				id: 7,
				result: {
					content: [
						{
							type: 'text',
							text: RETIREMENT_COPY.retired(
								`${BASE}/workshops/feedback-loops/intro`,
							),
						},
					],
					isError: true,
				},
			},
		])
	})

	it('leaves initialize, tools/list and notifications for the agent', () => {
		const body = [
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'my_courses' },
			},
		]
		const { answered, rest, batch } = answerRetiredToolCalls(body, BASE)
		expect(batch).toBe(true)
		expect(rest).toEqual(body.slice(0, 3))
		expect(answered).toHaveLength(1)
		expect(answered[0]).toMatchObject({ id: 3, result: { isError: true } })
	})

	it('answers nothing for a body with no tool call', () => {
		const { answered } = answerRetiredToolCalls(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			BASE,
		)
		expect(answered).toEqual([])
	})
})

describe('notice', () => {
	it('adds the notice to tool results only', () => {
		const toolResult = {
			jsonrpc: '2.0',
			id: 1,
			result: { content: [{ type: 'text', text: 'lesson' }] },
		}
		const listResult = { jsonrpc: '2.0', id: 2, result: { tools: [] } }
		const error = { jsonrpc: '2.0', id: 3, error: { code: -1, message: 'x' } }
		expect(withNoticeOnToolResults([toolResult, listResult, error])).toEqual([
			{
				...toolResult,
				result: {
					content: [
						{ type: 'text', text: 'lesson' },
						{ type: 'text', text: RETIREMENT_COPY.notice },
					],
				},
			},
			listResult,
			error,
		])
	})

	it('adds a notice field to HTTP objects and leaves the rest alone', () => {
		expect(withNoticeOnHttpBody({ ok: true })).toEqual({
			ok: true,
			notice: RETIREMENT_COPY.notice,
		})
		expect(withNoticeOnHttpBody([1, 2])).toEqual([1, 2])
	})

	it('keeps customer-facing copy free of em dashes', () => {
		for (const text of [
			RETIREMENT_COPY.notice,
			RETIREMENT_COPY.signInClosed,
			RETIREMENT_COPY.retired(BASE),
		])
			expect(text).not.toContain('\u2014')
	})
})
