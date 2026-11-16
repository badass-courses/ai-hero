import { createHash } from 'node:crypto'

import {
	allowedValuePathHelpUrl,
	parseValuePathAnswerPageResource,
	type ValuePathAnswerPageResource,
} from './value-path-answer-page'
import {
	personalizeDrovrIntent,
	type DrovrPersonalizeRepository,
} from './drovr-personalize'

const individual = 'ai-hero-skills-workflow'
const team = 'ai-hero-skills-team-workflow'
const now = '2026-11-01T12:00:00.000Z'

/** Read-only prepublication gate. Run on the exact dry-run resource plan.
 * Keep the digest with the release receipt; any edit requires a new check.
 * No DB, provider calls, link-anchor writes, or content publication.
 */
export async function checkValuePathAnswerPublication(args: {
	baselineResources: unknown[]
	candidateResources: unknown[]
	requireNewPages?: boolean
}) {
	const errors: string[] = []
	const baseline = args.baselineResources
		.map(parseValuePathAnswerPageResource)
		.filter((page): page is ValuePathAnswerPageResource => page !== null)
	const candidateAnswers = args.candidateResources.filter((resource) => {
		if (!resource || typeof resource !== 'object') return false
		const candidate = resource as {
			type?: unknown
			fields?: { kind?: unknown }
		}
		return (
			candidate.type === 'value-path-page' &&
			candidate.fields?.kind === 'answer'
		)
	})
	const candidates = candidateAnswers
		.map(parseValuePathAnswerPageResource)
		.filter((page): page is ValuePathAnswerPageResource => page !== null)
	if (candidates.length !== candidateAnswers.length)
		errors.push('candidate-resource-invalid')
	const ids = new Set(baseline.map((page) => page.id))
	const routeKey = (page: ValuePathAnswerPageResource) =>
		JSON.stringify([
			page.fields.sequenceId,
			page.fields.emailId,
			page.fields.slug,
		])
	// Existing certificate options intentionally share a baseline route. Do not
	// change that contract; reject any new page reusing an occupied route.
	const routes = new Set(baseline.map(routeKey))
	for (const page of [...baseline, ...candidates]) {
		if (
			page.fields.sequenceId === individual &&
			/^email-[1-5]$/.test(page.fields.emailId ?? '') &&
			page.fields.nextEmailResourceId?.startsWith(`${team}.`)
		)
			errors.push(`team-switch-requires-spec-rework:${page.id}`)
	}
	for (const page of candidates) {
		const f = page.fields
		if (ids.has(page.id)) errors.push(`duplicate-page-id:${page.id}`)
		ids.add(page.id)
		const route = routeKey(page)
		if (routes.has(route)) errors.push(`duplicate-answer-route:${page.id}`)
		routes.add(route)
		if (f.sequenceId !== individual)
			errors.push(`candidate-sequence-invalid:${page.id}`)
		if (f.helpUrl && !allowedValuePathHelpUrl(f.helpUrl))
			errors.push(`help-url-invalid:${page.id}`)
		if (f.helpUrl && !f.helpLabel) errors.push(`help-label-missing:${page.id}`)
		if (
			((f.clickIntent === 'deferred' || f.clickIntent === 'record') &&
				(f.nextEmailResourceId || f.nextEmailId || f.nextSequenceId)) ||
			f.captureFieldKey ||
			f.captureDateFieldKey
		)
			errors.push(`candidate-side-effect-forbidden:${page.id}`)
		if (f.variant === 'did-it') {
			if (
				!/^email-[1-5]$/.test(f.emailId ?? '') ||
				f.surveyId !== `${f.emailId}-did-it` ||
				!['done', 'stuck', 'later'].includes(f.optionValue ?? '') ||
				f.clickIntent !== (f.optionValue === 'done' ? 'confirmed' : 'deferred')
			)
				errors.push(`did-it-fields-invalid:${page.id}`)
		} else if (f.variant === 'goal') {
			if (
				f.emailId !== 'email-0' ||
				f.surveyId !== 'email-0-goal' ||
				f.clickIntent !== 'record' ||
				!['shipping', 'day-job', 'exploring', 'other'].includes(
					f.optionValue ?? '',
				)
			)
				errors.push(`goal-fields-invalid:${page.id}`)
		} else errors.push(`candidate-variant-missing:${page.id}`)
	}
	if (args.requireNewPages) {
		if (candidates.length !== 19) errors.push('expected-19-new-pages')
		for (let n = 1; n <= 5; n++) {
			const pages = candidates.filter(
				(page) =>
					page.fields.emailId === `email-${n}` &&
					page.fields.variant === 'did-it',
			)
			if (
				pages.length !== 3 ||
				new Set(pages.map((p) => p.fields.optionValue)).size !== 3 ||
				JSON.stringify(pages.map((p) => p.fields.position).sort()) !== '[1,2,3]'
			)
				errors.push(`did-it-set-invalid:email-${n}`)
		}
		const goals = candidates.filter((p) => p.fields.variant === 'goal')
		if (
			goals.length !== 4 ||
			new Set(goals.map((p) => p.fields.optionValue)).size !== 4 ||
			JSON.stringify(goals.map((p) => p.fields.position).sort()) !== '[1,2,3,4]'
		)
			errors.push('goal-set-invalid')
	}
	const repository: DrovrPersonalizeRepository = {
		findContactById: () => ({
			id: 'publication-check',
			email: 'check@example.test',
			lifecycle: 'nurture-ready',
			isProvisional: false,
			createdAt: now,
			updatedAt: now,
		}),
		findCurrentContactState: () => ({
			id: 'publication-state',
			contactId: 'publication-check',
			lifecycle: 'nurture-ready',
			primaryBucket: 'unclear',
			allBuckets: [],
			whySignals: [],
			whoSignals: [],
			confidence: 1,
			rationale: [],
			reviewSignals: [],
			humanReview: false,
			lastEventId: 'publication-event',
			schemaVersion: 1,
			updatedAt: now,
		}),
		findContactEventsByType: () => [],
		findValuePathEmailSideEffectIntentsByContact: () => [],
		findSideEffectIntentByIdempotencyKey: () => undefined,
	}
	const run = (emailKey: string, answerPages: ValuePathAnswerPageResource[]) =>
		personalizeDrovrIntent({
			repository,
			request: {
				tenantId: 'org-aihero',
				contactId: 'publication-check',
				journeyId: 'value-path-skills-course',
				journeyVersion: 13,
				emailKey,
				idempotencyKey: 'publication-check',
				dueAt: now,
			},
			answerPages,
			baseUrl: 'https://www.aihero.dev',
			pathTokenSecret: 'publication-check-test-secret',
			kitSubscriberId: 'test-kit',
		})
	let ordinarySendsChecked = 0
	for (const [sequence, prefix] of [
		[individual, 'email'],
		[team, 'team-email'],
	]) {
		for (let n = 0; n <= 7; n++) {
			const key = `${sequence}.${prefix}-${n}`
			const before = await run(key, baseline)
			const after = await run(key, [...baseline, ...candidates])
			if (!before?.sendable) errors.push(`baseline-unsendable:${key}`)
			if (JSON.stringify(before) !== JSON.stringify(after))
				errors.push(`ordinary-response-changed:${key}`)
			ordinarySendsChecked++
		}
	}
	if (args.requireNewPages) {
		for (let n = 1; n <= 5; n++) {
			const answer = await run(`${individual}.email-${n}b`, [
				...baseline,
				...candidates,
			])
			if (
				!answer?.sendable ||
				answer.reasons.length ||
				JSON.parse(answer.variables.aih_value_path_answer_links_json ?? '[]')
					.length !== 3
			)
				errors.push(`did-it-personalize-failed:email-${n}b`)
		}
	}
	return {
		passed: errors.length === 0,
		errors,
		ordinarySendsChecked,
		baselineAnswers: baseline.length,
		candidateAnswers: candidates.length,
		pageSetSha256: createHash('sha256')
			.update(JSON.stringify(args))
			.digest('hex'),
	}
}
