import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { readKitSubscriberTags } from '../../scripts/held-exit-kit-scan'
import {
	decideExitTag,
	EXIT_RULE_ACTION,
	exitTagReceipt,
	parseHeldRecoveryArgs,
	recoveryPrompt,
	runHeldExitRecovery,
	runHeldRecoveryBatch,
	type ExitTagFact,
	type ExitTagProofInput,
	type RecoveryRuntime,
} from '../../scripts/held-exit-recover'
import { InMemorySubscriberMarketingRepository } from '../lib/subscriber-marketing/dry-run'
import {
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	readOldSequenceMembership,
} from '../lib/subscriber-marketing/old-newsletter-exit'
import type {
	ContactRecord,
	SideEffectIntent,
} from '../lib/subscriber-marketing/types'

const TAG = 4242
const SINCE = '2026-10-16T10:00:00.000Z'
const NOW = '2026-10-16T12:00:00.000Z'
const proof: ExitTagProofInput = {
	kind: 'exit-tag',
	tagId: TAG,
	ruleActiveSince: SINCE,
	kitRuleId: 77,
	ruleAction: EXIT_RULE_ACTION,
}
const decide = (
	tags: ExitTagFact[],
	over: Partial<{ tagId: number; ruleActiveSince: string; now: string }> = {},
) =>
	decideExitTag({
		tags,
		tagId: TAG,
		ruleActiveSince: SINCE,
		now: NOW,
		...over,
	})

describe('decideExitTag (pure)', () => {
	it('passes when tagged after the rule start and past the grace window', () => {
		expect(decide([{ id: TAG, taggedAt: '2026-10-16T11:00:00Z' }])).toEqual({
			ok: true,
			taggedAt: '2026-10-16T11:00:00.000Z',
		})
	})
	it('passes a tag 59s after active-since when now is well past it', () => {
		expect(
			decide([{ id: TAG, taggedAt: '2026-10-16T10:00:59Z' }]),
		).toMatchObject({ ok: true })
	})
	it('refuses when the tag is missing or a different tag is present', () => {
		const other = [{ id: 9, taggedAt: '2026-10-16T11:00:00Z' }]
		expect(decide([])).toEqual({ ok: false, reason: 'exit-tag-missing' })
		expect(decide(other)).toEqual({ ok: false, reason: 'exit-tag-missing' })
	})
	it('refuses a tag applied before the rule went live', () => {
		expect(decide([{ id: TAG, taggedAt: '2026-10-16T09:59:59Z' }])).toEqual({
			ok: false,
			reason: 'exit-tag-before-rule',
		})
	})
	it('refuses a tag inside the two minute grace window, accepts the boundary', () => {
		const tagged = [{ id: TAG, taggedAt: '2026-10-16T11:59:00Z' }]
		expect(decide(tagged)).toEqual({
			ok: false,
			reason: 'exit-tag-too-recent',
		})
		expect(decide(tagged, { now: '2026-10-16T12:00:59Z' })).toEqual({
			ok: false,
			reason: 'exit-tag-too-recent',
		})
		expect(decide(tagged, { now: '2026-10-16T12:01:00Z' })).toMatchObject({
			ok: true,
		})
	})
	it.each([23763332, 22309615])('refuses denied tag id %i', (tagId) => {
		expect(
			decide([{ id: tagId, taggedAt: '2026-10-16T11:00:00Z' }], { tagId }),
		).toEqual({ ok: false, reason: 'exit-tag-denied' })
	})
	it.each(['not-a-date', '', '2026-13-45T00:00:00Z'])(
		'refuses a malformed tagged_at %j',
		(taggedAt) => {
			expect(decide([{ id: TAG, taggedAt }])).toEqual({
				ok: false,
				reason: 'exit-proof-unreadable',
			})
		},
	)
	it('refuses malformed attested or clock inputs', () => {
		const tags = [{ id: TAG, taggedAt: '2026-10-16T11:00:00Z' }]
		expect(decide(tags, { ruleActiveSince: 'soon' })).toMatchObject({
			ok: false,
		})
		expect(decide(tags, { now: 'later' })).toMatchObject({ ok: false })
	})
	it('refuses a duplicated exit tag entry', () => {
		const tag = { id: TAG, taggedAt: '2026-10-16T11:00:00Z' }
		expect(decide([tag, tag])).toMatchObject({ ok: false })
	})
})

const page = (
	tags: { id: number; tagged_at: string }[],
	next?: string,
): Response =>
	new Response(
		JSON.stringify({
			tags: tags.map((tag) => ({ ...tag, name: 'fixture' })),
			pagination: {
				has_next_page: Boolean(next),
				end_cursor: next ?? null,
			},
		}),
	)

describe('readKitSubscriberTags', () => {
	it('reads page 2 when the exit tag is only there, with auth and cursor', async () => {
		const fetcher = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(
			async (url) =>
				String(url).includes('after=cursor-1')
					? page([{ id: TAG, tagged_at: '2026-10-16T11:00:00Z' }])
					: page([{ id: 1, tagged_at: '2026-10-01T00:00:00Z' }], 'cursor-1'),
		)
		const tags = await readKitSubscriberTags({
			apiKey: 'fixture-key',
			fetch: fetcher,
			subscriberId: '123',
		})
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(String(fetcher.mock.calls[0]?.[0])).toContain(
			'https://api.kit.com/v4/subscribers/123/tags',
		)
		expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
			'X-Kit-Api-Key': 'fixture-key',
		})
		expect(decide(tags)).toMatchObject({ ok: true })
	})
	it('refuses a cursor loop, a bad shape and a non-200', async () => {
		const loop = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(
			async () => page([], 'same'),
		)
		await expect(
			readKitSubscriberTags({ apiKey: 'k', fetch: loop, subscriberId: '1' }),
		).rejects.toMatchObject({ reason: 'exit-proof-unreadable' })
		for (const response of [
			() => new Response('{}'),
			() => new Response('{}', { status: 500 }),
			() => page([{ id: 1, tagged_at: 'bad' }]),
		])
			await expect(
				readKitSubscriberTags({
					apiKey: 'k',
					fetch: vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(
						async () => response(),
					),
					subscriberId: '1',
				}),
			).rejects.toMatchObject({ reason: 'exit-proof-unreadable' })
	})
})

const contact: ContactRecord = {
	id: 'fixture-contact',
	email: 'fixture@example.test',
	name: 'Fixture',
	lifecycle: 'new',
	isProvisional: false,
	createdAt: '2026-10-06T12:00:00.000Z',
	updatedAt: '2026-10-06T12:00:00.000Z',
}
const held: SideEffectIntent = {
	id: 'fixture-row',
	contactId: contact.id,
	nextActionId: 'fixture-action',
	provider: 'kit',
	type: 'subscribe-evergreen-list',
	status: 'held-for-exit',
	idempotencyKey: `contact:${contact.id}:evergreen:list:shadow-newsletter`,
	createdAt: contact.createdAt,
	gates: [],
	reviewReasons: ['old-newsletter-exit-unconfirmed'],
	metadata: { list: 'shadow-newsletter', source: 'drovr' },
}
function runtime(tags: ExitTagFact[]) {
	const repository = new InMemorySubscriberMarketingRepository()
	const scan = vi.fn(async () => {
		throw new Error('scan must not run in exit-tag mode')
	})
	const value: RecoveryRuntime = {
		approvalScope: 'fixture-scope',
		now: () => NOW,
		readback: async () => ({ eventDerivable: false, outbox: [] }),
		currentMembership: async (id) => readOldSequenceMembership(repository, id),
		findContactById: async (id) => (id === contact.id ? contact : undefined),
		inspect: async () => ({
			rows: [structuredClone(held)],
			identities: [
				{ id: 'fixture-identity', contactId: contact.id, externalId: '123' },
			],
			history: repository.findContactEventsByType(
				contact.id,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		}),
		scan,
		exitTags: vi.fn(async () => tags),
		persist: vi.fn(async (input) => repository.createContactEvent(input)),
		notify: vi.fn(async () => 1),
	}
	return { value, scan }
}
const good: ExitTagFact[] = [{ id: TAG, taggedAt: '2026-10-16T11:00:00Z' }]
const dry = (exitProof: ExitTagProofInput) => ({
	mode: 'dry-run' as const,
	namespace: 'ai-hero' as const,
	contactId: contact.id,
	exitProof,
})
const plan = async (exitProof: ExitTagProofInput, tags = good) =>
	Effect.runPromise(runHeldExitRecovery(dry(exitProof), runtime(tags).value))

describe('exit-tag recovery', () => {
	it('plans, records the receipt facts, never scans and leaks no email', async () => {
		const { value, scan } = runtime(good)
		const planned = await Effect.runPromise(
			runHeldExitRecovery(dry({ ...proof, ruleHistoryEntryCount: 1 }), value),
		)
		expect(planned).toMatchObject({
			status: 'planned',
			checks: { exitTagProven: true },
			exitProof: {
				proofKind: 'exit-tag',
				tagId: TAG,
				taggedAt: '2026-10-16T11:00:00.000Z',
				ruleActiveSince: SINCE,
				kitRuleId: 77,
				ruleAction: EXIT_RULE_ACTION,
				ruleHistoryEntryCount: 1,
				attestation: 'operator-attested from Kit UI, not API-read',
				gap: 'no-api-sequence-send-history',
			},
		})
		expect(planned.exitProof?.oneWayEffect).toContain('drovr shadow newsletter')
		expect(planned.exitProof?.digest).toMatch(/^[a-f0-9]{64}$/)
		expect(scan).not.toHaveBeenCalled()
		expect(JSON.stringify(planned)).not.toContain(contact.email)
	})

	it.each([
		['exit-tag-missing', []],
		['exit-tag-before-rule', [{ id: TAG, taggedAt: '2026-10-16T09:00:00Z' }]],
		['exit-tag-too-recent', [{ id: TAG, taggedAt: '2026-10-16T11:59:30Z' }]],
	])('refuses with %s and a literal prompt', async (reason, tags) => {
		const result = await plan(proof, tags)
		expect(result).toMatchObject({ status: 'refused', reason })
		expect(result.prompt).toMatch(/^ExitProofUnreadable: /)
		expect(result.prompt).toBe(recoveryPrompt(reason))
	})

	it('write must match the dry-run plan hash and persists the exit-tag receipt', async () => {
		const planned = await plan(proof)
		const { value } = runtime(good)
		const wrong = await Effect.runPromise(
			runHeldExitRecovery(
				{
					...dry(proof),
					mode: 'write',
					approval: 'fixture',
					planHash: 'a'.repeat(64),
				},
				value,
			),
		)
		expect(wrong.reason).toBe('plan-hash-mismatch')
		const written = await Effect.runPromise(
			runHeldExitRecovery(
				{
					...dry(proof),
					mode: 'write',
					approval: 'fixture',
					planHash: planned.planHash!,
				},
				value,
			),
		)
		expect(written.status).toBe('requested')
		expect(value.persist).toHaveBeenCalledOnce()
		const summary = JSON.parse(
			String(
				vi.mocked(value.persist).mock.calls[0]?.[0].payloadSummary?.summary,
			),
		)
		expect(summary.exitProof).toMatchObject({
			proofKind: 'exit-tag',
			tagId: TAG,
		})
		expect(JSON.stringify(summary)).not.toContain(contact.email)
	})

	it('plan hash covers every proof input and the observed tag time', async () => {
		const base = (await plan(proof)).planHash
		expect(base).toMatch(/^[a-f0-9]{64}$/)
		const variants: ExitTagProofInput[] = [
			{ ...proof, kitRuleId: 78 },
			{ ...proof, ruleActiveSince: '2026-10-16T10:30:00.000Z' },
			{ ...proof, ruleHistoryEntryCount: 1 },
		]
		for (const variant of variants)
			expect((await plan(variant)).planHash).not.toBe(base)
		const otherTag = 5151
		expect(
			(
				await plan({ ...proof, tagId: otherTag }, [
					{ id: otherTag, taggedAt: '2026-10-16T11:00:00Z' },
				])
			).planHash,
		).not.toBe(base)
		expect(
			(await plan(proof, [{ id: TAG, taggedAt: '2026-10-16T11:30:00Z' }]))
				.planHash,
		).not.toBe(base)
	})

	it('receipt digest changes with the rule action and rule id', () => {
		const at = '2026-10-16T11:00:00.000Z'
		const base = exitTagReceipt(proof, at).digest
		expect(
			exitTagReceipt({ ...proof, ruleAction: 'other' }, at).digest,
		).not.toBe(base)
		expect(exitTagReceipt({ ...proof, kitRuleId: 1 }, at).digest).not.toBe(base)
	})

	it('refuses a tag earlier than active-since even when the plan would hash fine', async () => {
		expect(
			(await plan(proof, [{ id: TAG, taggedAt: '2026-10-15T00:00:00Z' }]))
				.status,
		).toBe('refused')
	})

	it('keeps the exit proof through a batch dry run', async () => {
		const { value } = runtime(good)
		const result = await Effect.runPromise(
			runHeldRecoveryBatch(
				{
					...dry(proof),
					contacts: [
						{ namespace: 'ai-hero', contactId: contact.id },
						{ namespace: 'ai-hero', contactId: contact.id },
					],
				},
				value,
			),
		)
		expect(result.results?.every((r) => r.exitProof)).toBe(true)
	})

	it('refuses when the runtime has no tag reader', async () => {
		const { value } = runtime(good)
		delete value.exitTags
		const result = await Effect.runPromise(
			runHeldExitRecovery(dry(proof), value),
		)
		expect(result.reason).toBe('exit-proof-unreadable')
	})
})

describe('exit-tag argv', () => {
	const base = ['--contact-id', contact.id]
	const full = [
		'--exit-proof',
		'exit-tag',
		'--exit-tag-id',
		String(TAG),
		'--kit-rule-id',
		'77',
		'--rule-active-since',
		SINCE,
		'--rule-action',
		EXIT_RULE_ACTION,
	]
	it('parses the full input and leaves scan mode untouched', () => {
		expect(parseHeldRecoveryArgs([...base, ...full])).toMatchObject({
			exitProof: proof,
		})
		expect(parseHeldRecoveryArgs([...base, '--exit-proof', 'scan'])).toEqual(
			parseHeldRecoveryArgs(base),
		)
		expect(
			parseHeldRecoveryArgs([
				...base,
				...full,
				'--rule-history-entry-count',
				'1',
			]).exitProof?.ruleHistoryEntryCount,
		).toBe(1)
	})
	it.each([
		['missing tag id', ['--exit-tag-id']],
		['missing rule id', ['--kit-rule-id']],
		['missing since', ['--rule-active-since']],
		['missing action', ['--rule-action']],
	])('refuses %s as ExitProofUnreadable', (_name, drop) => {
		const argv = [...base, ...full]
		const at = argv.indexOf(drop[0]!)
		argv.splice(at, 2)
		expect(() => parseHeldRecoveryArgs(argv)).toThrowError(
			expect.objectContaining({ reason: 'exit-proof-unreadable' }),
		)
	})
	it.each([
		['--exit-tag-id', '0'],
		['--exit-tag-id', 'abc'],
		['--kit-rule-id', '-3'],
		['--rule-active-since', 'yesterday'],
		['--rule-active-since', '2026-10-16'],
		['--rule-action', 'unsubscribe-from-sequence:1'],
		['--rule-history-entry-count', '2'],
	])('refuses malformed %s %s', (flag, value) => {
		const argv = [...base, ...full]
		const at = argv.indexOf(flag)
		if (at >= 0) argv[at + 1] = value
		else argv.push(flag, value)
		expect(() => parseHeldRecoveryArgs(argv)).toThrowError(
			expect.objectContaining({ reason: 'exit-proof-unreadable' }),
		)
	})
	it.each(['23763332', '22309615'])('refuses denied tag id %s', (id) => {
		const argv = [...base, ...full]
		argv[argv.indexOf('--exit-tag-id') + 1] = id
		expect(() => parseHeldRecoveryArgs(argv)).toThrowError(
			expect.objectContaining({ reason: 'exit-tag-denied' }),
		)
	})
	it('refuses stray exit flags without exit-tag, unknown kinds and readback', () => {
		for (const argv of [
			[...base, '--exit-tag-id', '5'],
			[...base, '--exit-proof', 'bogus'],
			[...base, '--readback', ...full],
		])
			expect(() => parseHeldRecoveryArgs(argv)).toThrow()
	})
})
