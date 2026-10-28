import { describe, expect, it } from 'vitest'
import type { DrovrContactResolution } from './drovr-purchase-resolve'
import {
	goalInterestFact,
	GOAL_QUESTION_ID,
	GOAL_RESOURCE_ID,
	GOAL_ROLES,
	planScopeInterestFacts,
	SCOPE_QUESTION_ID,
	type ScopeAnswerSource,
} from './survey-interest-facts'

const row = (extra: Partial<ScopeAnswerSource> = {}): ScopeAnswerSource => ({
	id: 'event-1',
	contactId: 'app-contact',
	email: 'human@example.test',
	occurredAt: '2026-10-28T17:20:00.000Z',
	keywords: [SCOPE_QUESTION_ID, 'personal'],
	contactClicks: 4,
	stepClicks: 1,
	...extra,
})
const resolved = new Map<string, DrovrContactResolution>([
	['human@example.test', { status: 'resolved', contactId: 'drovr-contact' }],
])

describe('survey interest facts', () => {
	it.each(GOAL_ROLES)(
		'uses the exact goal role %s and immutable source identity',
		(answer) => {
			const source = {
				id: 'response-1',
				questionId: GOAL_RESOURCE_ID,
				answer,
				createdAt: new Date('2026-10-28T17:20:00Z'),
				contactId: 'drovr-contact',
			}
			const fact = goalInterestFact(source)
			expect(fact).toEqual({
				contactId: 'drovr-contact',
				kind: `survey.answer.stated.${GOAL_QUESTION_ID}`,
				role: answer,
				at: '2026-10-28T17:20:00.000Z',
				sourceId: '["aihero","AI_QuestionResponse","response-1"]',
			})
			expect(
				goalInterestFact({ ...source, questionId: GOAL_QUESTION_ID }),
			).toEqual(fact)
			expect(
				goalInterestFact({ ...source, id: 'response-2' })?.sourceId,
			).not.toBe(fact?.sourceId)
		},
	)
	it('ignores unrelated questions, unknown values and multi-selections', () => {
		const source = {
			id: 'r',
			questionId: GOAL_QUESTION_ID,
			answer: 'team_workflows, ship_first_ai_feature',
			createdAt: new Date(),
			contactId: 'c',
		}
		expect(goalInterestFact(source)).toBeUndefined()
		expect(
			goalInterestFact({
				...source,
				questionId: 'unrelated',
				answer: 'team_workflows',
			}),
		).toBeUndefined()
	})
	it('drops scanner-classified rows outright, infers only unclassified legacy clicks, and deduplicates source ids', () => {
		const rows = [
			row(),
			row(),
			row({ id: 'scanner', contactId: 'scan', contactClicks: 15 }),
			row({ id: 'step-scanner', contactId: 'scan2', stepClicks: 3 }),
			row({ id: 'repeat-answer' }),
		]
		const { facts, counts } = planScopeInterestFacts({ rows, resolved })
		expect(counts).toMatchObject({
			scannerDrops: 2,
			duplicates: 1,
			unresolvedRows: 0,
			byRole: { personal: 2, team: 0, unsure: 0 },
		})
		expect(facts).toHaveLength(2)
		expect(facts[0]).toEqual({
			contactId: 'drovr-contact',
			at: row().occurredAt,
			kind: `survey.answer.inferred.${SCOPE_QUESTION_ID}`,
			role: 'personal',
			sourceId: '["aihero","AI_ContactEvent","event-1"]',
		})
		expect(JSON.stringify(facts)).not.toContain('human@example.test')
	})
	it('quarantines conflicting choices even under the volume ceiling', () => {
		const { facts, counts } = planScopeInterestFacts({
			rows: [
				row({ stepClicks: 2 }),
				row({
					id: 'second',
					stepClicks: 2,
					keywords: [SCOPE_QUESTION_ID, 'team'],
				}),
			],
			resolved,
		})
		expect(facts).toEqual([])
		expect(counts.ambiguousDrops).toBe(2)
	})
	it('counts missing/conflicting/no-email contacts without exposing identity', () => {
		const { counts } = planScopeInterestFacts({
			rows: [
				row(),
				row({ id: '2', contactId: 'c2', email: null }),
				row({ id: '3', contactId: 'c3', email: 'conflict@example.test' }),
			],
			resolved: new Map([['conflict@example.test', { status: 'conflict' }]]),
		})
		expect(counts).toMatchObject({
			unresolvedRows: 3,
			unresolvedContacts: 3,
			missingContacts: 2,
			conflictContacts: 1,
		})
	})
	it('refuses malformed options, missing scope keyword and invalid timestamps', () => {
		const { facts, counts } = planScopeInterestFacts({
			rows: [
				row({ keywords: ['personal'] }),
				row({ id: '2', keywords: [SCOPE_QUESTION_ID, 'other'] }),
				row({ id: '3', occurredAt: 'invalid' }),
			],
			resolved,
		})
		expect(facts).toEqual([])
		expect(counts.invalidDrops).toBe(3)
	})
})
