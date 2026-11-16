import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, afterEach } from 'vitest'

import {
	parseValuePathAnswerPageResource,
	allowedValuePathHelpUrl,
} from './value-path-answer-page'
import { previewValuePathContentImport } from './value-path-content-import-preview'
import { importValuePathContentResources } from './value-path-content-import'
import { checkValuePathAnswerPublication } from './value-path-answer-publish-check'
import {
	buildValuePathEmailPersonalization,
	valuePathAnswerPagesForEmail,
	canonicalSkillsMessageKey,
} from './value-path-email-executor'
import { verifyValuePathToken } from './path-token'
import { DrovrPersonalizeRequestSchema } from './drovr-personalize'
import { recordValuePathAnswerProgression } from './value-path-click-progression'
import { mapDrovrShadowFact } from './drovr-shadow-emitter'
import {
	InMemorySubscriberMarketingRepository,
	dryRunSubscriberMarketingFixture,
} from './dry-run'
import { codingWorkflowFixture } from './__fixtures__/quick-question-fixtures'
import { recordJourneyOwnerAssigned } from './drovr-ownership'

const sequence = 'ai-hero-skills-workflow'
const team = 'ai-hero-skills-team-workflow'
const now = '2026-11-01T12:00:00.000Z'
const secret = 'test-secret'
const makePage = (emailId: string, optionValue: string, extra = {}) => ({
	id: `${sequence}.${emailId}.${optionValue}`,
	type: 'value-path-page' as const,
	fields: {
		kind: 'answer' as const,
		slug: `${emailId}-${optionValue}`,
		sequenceId: sequence,
		emailId,
		surveyId: `${emailId}-quiz`,
		optionValue,
		position: 1,
		...extra,
	},
})
const candidates = [
	...Array.from({ length: 5 }, (_, i) =>
		['done', 'stuck', 'later'].map((optionValue, index) =>
			makePage(`email-${i + 1}`, optionValue, {
				variant: 'did-it',
				clickIntent: optionValue === 'done' ? 'confirmed' : 'deferred',
				surveyId: `email-${i + 1}-did-it`,
				position: index + 1,
			}),
		),
	).flat(),
	...['shipping', 'day-job', 'exploring', 'other'].map((optionValue, index) =>
		makePage('email-0', optionValue, {
			variant: 'goal',
			clickIntent: 'record',
			surveyId: 'email-0-goal',
			position: index + 1,
		}),
	),
]
const baseline = [sequence, team].flatMap((path) =>
	Array.from({ length: 8 }, (_, n) => ({
		...makePage(`${path === team ? 'team-' : ''}email-${n}`, 'quiz'),
		id: `${path}.answer-${n}`,
		fields: {
			...makePage(`${path === team ? 'team-' : ''}email-${n}`, 'quiz').fields,
			sequenceId: path,
		},
	})),
)
const parse = (pages: unknown[]) =>
	pages.map((p) => parseValuePathAnswerPageResource(p)!)
const build = (
	emailResourceId: string,
	answerPages: unknown[],
	messageKey?: string,
) =>
	buildValuePathEmailPersonalization({
		contactId: 'contract-test',
		kitSubscriberId: 'test-kit',
		valuePathSlug: sequence,
		emailResourceId,
		messageKey,
		answerPages: parse(answerPages),
		baseUrl: 'https://www.aihero.dev',
		pathTokenSecret: secret,
		now,
	})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('answer page import and prepublication contract', () => {
	it('preserves every new field through SVX -> preview -> dry-run resource -> readback for all 19 pages', async () => {
		const source = `<AnswerPageSet sequenceId="${sequence}">${candidates
			.map(
				(p) =>
					`<AnswerPage id="${p.id}" ${Object.entries(p.fields)
						.map(([k, v]) => `${k}="${v}"`)
						.join(
							' ',
						)} helpUrl="https://github.com/mattpocock/sandcastle" helpLabel="Guide"><Body>Test fixture</Body></AnswerPage>`,
			)
			.join('')}</AnswerPageSet>`
		const preview = previewValuePathContentImport({
			individualSequenceMdx: `<EmailSequence id="${sequence}"></EmailSequence>`,
			teamSequenceMdx: `<EmailSequence id="${team}"></EmailSequence>`,
			individualAnswerPagesMdx: source,
			teamAnswerPagesMdx: `<AnswerPageSet sequenceId="${team}"></AnswerPageSet>`,
		})
		const result = await importValuePathContentResources({ preview })
		expect(result.mode).toBe('dry-run')
		const pages = result.plan.resources.filter(
			(r) => r.fields.kind === 'answer',
		)
		expect(pages).toHaveLength(19)
		for (const [i, p] of pages.entries()) {
			expect(parseValuePathAnswerPageResource(p)?.fields).toMatchObject({
				...candidates[i]!.fields,
				helpUrl: 'https://github.com/mattpocock/sandcastle',
				helpLabel: 'Guide',
			})
		}
		expect(
			(
				await checkValuePathAnswerPublication({
					baselineResources: baseline,
					candidateResources: pages,
					requireNewPages: true,
				})
			).errors,
		).toEqual([])
	})

	it('compares full v13 responses, including every byte of every link and token, with fixed inputs', async () => {
		const result = await checkValuePathAnswerPublication({
			baselineResources: baseline,
			candidateResources: candidates,
			requireNewPages: true,
		})
		expect(result.errors).toEqual([])
		expect(result.ordinarySendsChecked).toBe(16)
	})

	it('fails closed on lost variant, suffix-only pages and goals for ordinary and legacy sends', () => {
		const quiz = makePage('email-1', 'quiz')
		const pages = parse([
			quiz,
			...candidates,
			makePage('email-1', 'lost', { surveyId: 'email-1-did-it' }),
			makePage('email-1', 'goal-lost', { surveyId: 'email-1-goal' }),
		])
		for (const messageKey of [undefined, `${sequence}.email-1`]) {
			expect(
				valuePathAnswerPagesForEmail({
					valuePathSlug: sequence,
					emailResourceId: `${sequence}.email-1`,
					messageKey,
					answerPages: pages,
				}).map((p) => p.id),
			).toEqual([quiz.id])
		}
	})

	it.each([1, 2, 3, 4, 5])(
		'maps email-%ib links to canonical resource ids and exactly three did-it pages',
		(n) => {
			const messageKey = `${sequence}.email-${n}b`
			const canonical = canonicalSkillsMessageKey(messageKey)
			expect(canonical).toBe(`${sequence}.email-${n}`)
			const result = build(canonical, [...baseline, ...candidates], messageKey)
			expect(result.reviewReasons).toEqual([])
			const links = JSON.parse(
				(result.fields as Record<string, string>)
					.aih_value_path_answer_links_json!,
			)
			expect(links).toHaveLength(3)
			for (const [i, link] of links.entries()) {
				expect(link.optionValue).toBe(['done', 'stuck', 'later'][i])
				const token = verifyValuePathToken({
					token: new URL(link.href).searchParams.get('pt')!,
					secret,
					now: new Date(now),
				})
				expect(token.valid).toBe(true)
				if (token.valid) expect(token.payload.emailResourceId).toBe(canonical)
			}
		},
	)

	it.each([
		'https://evil.test',
		'http://aihero.dev/guide',
		'https://aihero.dev.evil.test',
		'https://github.com/mattpocock-evil/repo',
		'https://github.com/other/repo',
		'https://user@aihero.dev',
		'javascript:alert(1)',
	])(
		'rejects unsafe help URL %s at publication and rendering',
		async (helpUrl) => {
			expect(allowedValuePathHelpUrl(helpUrl)).toBeUndefined()
			const bad = structuredClone(candidates)
			Object.assign(bad[0]!.fields, { helpUrl, helpLabel: 'Guide' })
			expect(
				(
					await checkValuePathAnswerPublication({
						baselineResources: baseline,
						candidateResources: bad,
						requireNewPages: true,
					})
				).passed,
			).toBe(false)
		},
	)
	it.each([
		'https://aihero.dev/guide',
		'https://www.aihero.dev/guide',
		'https://github.com/mattpocock/sandcastle',
	])('allows guide %s', (url) => expect(allowedValuePathHelpUrl(url)).toBe(url))

	it('accepts an unknown positive journey version and preserves missing-version input', () => {
		const request = {
			tenantId: 'org-aihero',
			contactId: 'test',
			journeyId: 'value-path-skills-course',
			emailKey: `${sequence}.email-0`,
			idempotencyKey: 'test',
			dueAt: now,
		}
		expect(DrovrPersonalizeRequestSchema.parse(request)).toEqual(request)
		expect(
			DrovrPersonalizeRequestSchema.parse({ ...request, journeyVersion: 999 })
				.journeyVersion,
		).toBe(999)
	})

	it('stops on a later lesson team switch or malformed new page', async () => {
		const switched = makePage('email-1', 'team', {
			nextEmailResourceId: `${team}.team-email-2`,
		})
		expect(
			(
				await checkValuePathAnswerPublication({
					baselineResources: [switched],
					candidateResources: [],
				})
			).errors,
		).toContain(`team-switch-requires-spec-rework:${switched.id}`)
		const malformed = structuredClone(candidates)
		Object.assign(malformed[0]!.fields, {
			nextEmailResourceId: `${sequence}.email-2`,
			captureFieldKey: 'unsafe',
		})
		expect(
			(
				await checkValuePathAnswerPublication({
					baselineResources: baseline,
					candidateResources: malformed,
					requireNewPages: true,
				})
			).passed,
		).toBe(false)
	})
})

describe('answer write -> drovr contract', () => {
	it('keeps path and distinct goal keys separate; A, B, A stores two goals and captures nothing', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now,
		})
		const before = repository.nextActions.size
		const token = {
			contactId: captured.contact.id,
			valuePathResourceId: sequence,
			sequenceId: sequence,
			emailResourceId: `${sequence}.email-0`,
			expiresAt: '2027-01-01T00:00:00.000Z',
		}
		const path = parseValuePathAnswerPageResource(
			makePage('email-0', 'personal', {
				nextEmailResourceId: `${sequence}.email-1`,
			}),
		)!
		const goals = parse(
			candidates.filter((page) => page.fields.emailId === 'email-0'),
		)
		const eventsBefore = repository.contactEvents.size
		// Record-only pages ignore accidental capture instructions at runtime too.
		const first = {
			...goals[0]!,
			fields: {
				...goals[0]!.fields,
				captureFieldKey: 'must-not-write',
				captureDateFieldKey: 'must-not-stamp',
			},
		}
		const a = await recordValuePathAnswerProgression({
			repository,
			token,
			answerPage: first,
			now,
		})
		const b = await recordValuePathAnswerProgression({
			repository,
			token,
			answerPage: goals[1]!,
			now,
		})
		const again = await recordValuePathAnswerProgression({
			repository,
			token,
			answerPage: first,
			now,
		})
		expect(a.status).toBe('recorded')
		expect(b.status).toBe('recorded')
		if (
			a.status === 'skipped' ||
			b.status === 'skipped' ||
			again.status === 'skipped'
		)
			throw new Error('goal was not recorded')
		expect(again.contactEventId).toBe(a.contactEventId)
		expect(again.status).toBe('idempotent-noop')
		expect(repository.contactEvents.size).toBe(eventsBefore + 2)
		expect(repository.nextActions.size).toBe(before)
		const keys = [a, b].map((result) => {
			return repository.contactEvents.get(result.contactEventId!)!
				.semanticIdempotencyKey
		})
		expect(new Set(keys).size).toBe(2)
		expect(keys).not.toContain(
			`contact:${captured.contact.id}:value-path:${sequence}:answer:${path.id}`,
		)
	})

	it.each([undefined, 'confirmed', 'deferred', 'record'] as const)(
		'records %s with stable per-page keys and no accidental next-action writes',
		async (intent) => {
			const repository = new InMemorySubscriberMarketingRepository()
			const captured = await dryRunSubscriberMarketingFixture({
				repository,
				fixture: codingWorkflowFixture,
				now,
			})
			await recordJourneyOwnerAssigned({
				repository,
				contactId: captured.contact.id,
				providerIdentityId: 'test',
				kitSubscriberId: 'test-kit',
				email: captured.contact.email!,
				occurredAt: now,
			})
			const before = repository.nextActions.size
			const token = {
				contactId: captured.contact.id,
				valuePathResourceId: sequence,
				sequenceId: sequence,
				emailResourceId: `${sequence}.email-1`,
				expiresAt: '2027-01-01T00:00:00.000Z',
			}
			const page = parseValuePathAnswerPageResource(
				makePage('email-1', intent === 'deferred' ? 'stuck' : 'done', {
					clickIntent: intent,
					surveyId: 'email-1-did-it',
					...(intent === 'deferred' || intent === 'record'
						? {}
						: { nextEmailResourceId: `${sequence}.email-2` }),
				}),
			)!
			const click = () =>
				recordValuePathAnswerProgression({
					repository,
					token,
					answerPage: page,
					now,
				})
			const first = await click()
			expect(first.status).toBe('recorded')
			if (first.status === 'skipped') throw new Error(first.reason)
			expect(repository.nextActions.size).toBe(before)
			const event = repository.contactEvents.get(first.contactEventId!)!
			expect(event.payloadSummary).toMatchObject({
				clickIntent: intent ?? 'confirmed',
				answer: page.fields.optionValue,
				surveyId: 'email-1-did-it',
			})
			expect((await click()).status).toBe('idempotent-noop')
			const mapped = mapDrovrShadowFact({ kind: 'contact-event', event })
			if (intent === 'record') expect(mapped).toEqual([])
			else {
				expect(mapped[0]?.payload).toEqual({
					emailResourceId: token.emailResourceId,
					answer: page.fields.optionValue,
					surveyId: 'email-1-did-it',
					...(intent === 'deferred' ? { clickIntent: 'deferred' } : {}),
				})
				vi.stubEnv('DROVR_FORWARD_DEFERRED', 'false')
				expect(
					mapDrovrShadowFact({ kind: 'contact-event', event })[0]?.payload,
				).not.toHaveProperty('clickIntent')
			}
			if (intent === 'record') {
				const other = {
					...page,
					id: `${page.id}-other`,
					fields: {
						...page.fields,
						optionValue: 'other',
						captureFieldKey: 'must-not-write',
						captureDateFieldKey: 'must-not-write',
						nextEmailResourceId: `${sequence}.email-2`,
					},
				}
				const second = await recordValuePathAnswerProgression({
					repository,
					token,
					answerPage: other,
					now,
				})
				if (second.status === 'skipped') throw new Error(second.reason)
				expect(second.contactEventId).not.toBe(first.contactEventId)
				expect(repository.nextActions.size).toBe(before)
			}
		},
	)
})

// Private exports stay outside the repo. Rerun this on the exact prospective
// resource plan with AIH_ANSWER_CANDIDATES_JSON and retain the digest receipt.
const baselinePath = process.env.AIH_ANSWER_BASELINE_JSON
const candidatePath = process.env.AIH_ANSWER_CANDIDATES_JSON
it.skipIf(!baselinePath)(
	'checks the supplied read-only export and prospective page set',
	async () => {
		const readPages = (path: string) => {
			const data = JSON.parse(readFileSync(path, 'utf8'))
			return Array.isArray(data)
				? data
				: (data.pages ?? data.resources ?? data.plan.resources)
		}
		const result = await checkValuePathAnswerPublication({
			baselineResources: readPages(baselinePath!),
			candidateResources: candidatePath ? readPages(candidatePath) : [],
			requireNewPages: !!candidatePath,
		})
		console.info('answer-publication-check', JSON.stringify(result))
		expect(result.errors).toEqual([])
	},
)
