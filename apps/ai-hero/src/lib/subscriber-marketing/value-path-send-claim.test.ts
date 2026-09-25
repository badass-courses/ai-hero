import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./drovr-shadow-dispatch', () => ({
	dispatchDrovrShadowFactSafely: vi.fn(),
}))

import { codingWorkflowFixture } from './__fixtures__/quick-question-fixtures'
import { acceptDrovrIntent, type DrovrIntent } from './drovr-executor'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from './dry-run'
import { getSkillsWorkflowEmailStep } from './skills-workflow-path'
import {
	executePendingValuePathEmailIntents,
	executeValuePathEmailIntent,
	KIT_ACCEPTED_COMPLETION_WRITE_FAILED,
	SEND_CLAIM_LOST,
	VALUE_PATH_SEND_CLAIM_STALE_MS,
	type ValuePathEmailExecutorConfig,
} from './value-path-email-executor'

/**
 * Every sender of a value-path email (the five-minute cron, drovr's POST, the
 * POST's background continuation) takes the row's claim before Kit, so two
 * senders racing on one row make exactly one Kit call.
 */

const EMAIL_6 = 'ai-hero-skills-workflow.email-6'
const step = getSkillsWorkflowEmailStep(EMAIL_6)!

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

async function seeded() {
	const repository = new InMemorySubscriberMarketingRepository()
	const captured = await dryRunSubscriberMarketingFixture({
		repository,
		fixture: codingWorkflowFixture,
		now: new Date(Date.now() - 60_000).toISOString(),
	})
	const config: ValuePathEmailExecutorConfig = {
		mode: 'allowlisted-test',
		allowlistedContactIds: [captured.contact.id],
		verifiedEmailResourceIds: [EMAIL_6],
		verifiedKitSequenceIds: [step.kitSequenceId],
		enabledValuePathSlugs: [step.valuePathSlug],
	}
	return { repository, contactId: captured.contact.id, config }
}

/** Kit that records each enrollment and holds it until released. */
function heldKit() {
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const calls: string[] = []
	return {
		calls,
		release: () => release(),
		provider: {
			async subscribeToList(args: { user: { email?: string } }) {
				calls.push(String(args.user.email))
				await gate
				return { id: 'kit-subscription-1', email_address: args.user.email }
			},
		},
	}
}

const drovrIntent = (contactId: string): DrovrIntent => ({
	tenantId: 'org-aihero',
	contactId,
	journeyId: 'value-path-skills-course',
	kind: 'email.send',
	idempotencyKey: `intent:org-aihero:${contactId}:value-path-skills-course:email6:0`,
	dueAt: new Date().toISOString(),
	payload: { emailResourceId: EMAIL_6 },
})

describe('value-path send claim: one Kit call per row across senders', () => {
	it('two cron runs over the same pending row make exactly one Kit call', async () => {
		const { repository, contactId, config } = await seeded()
		const posted = await acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
		})
		if (posted.status !== 'accepted') throw new Error('expected accepted')
		const kit = heldKit()

		// Both runs read the row as pending before either takes it.
		const runs = Promise.all([
			executePendingValuePathEmailIntents({
				repository,
				emailListProvider: kit.provider as never,
				config,
			}),
			executePendingValuePathEmailIntents({
				repository,
				emailListProvider: kit.provider as never,
				config,
			}),
		])
		await tick()
		expect(kit.calls).toHaveLength(1)
		kit.release()
		const [first, second] = await runs
		expect(kit.calls).toHaveLength(1)
		expect([...first, ...second].map((result) => result.status).sort()).toEqual(
			['completed', 'skipped'],
		)
		expect([...first, ...second]).toContainEqual({
			status: 'skipped',
			intentId: posted.intentId,
			reviewReasons: ['intent-claimed-by-another-sender'],
		})
		expect(repository.sideEffectIntents.get(posted.intentId)?.status).toBe(
			'completed',
		)
	})

	it('the cron steps back from a row a drovr POST is sending', async () => {
		const { repository, contactId, config } = await seeded()
		const kit = heldKit()
		const sendNow = (
			row: Parameters<typeof executeValuePathEmailIntent>[0]['intent'],
		) =>
			executeValuePathEmailIntent({
				repository,
				emailListProvider: kit.provider as never,
				intent: row,
				config,
			})
		const posted = await acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
		})
		if (posted.status !== 'accepted') throw new Error('expected accepted')

		// The cron read the pending row, then the POST took it first.
		const snapshot = repository.findPendingValuePathEmailSideEffectIntents({
			limit: 25,
		})
		const post = acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
			sendNow,
		})
		await tick()
		const cron = await executePendingValuePathEmailIntents({
			repository: {
				...bind(repository),
				findPendingValuePathEmailSideEffectIntents: () => snapshot,
			},
			emailListProvider: kit.provider as never,
			config,
		})
		expect(cron).toEqual([
			{
				status: 'skipped',
				intentId: posted.intentId,
				reviewReasons: ['intent-claimed-by-another-sender'],
			},
		])
		kit.release()
		expect(await post).toMatchObject({
			status: 'completed',
			intentId: posted.intentId,
		})
		expect(kit.calls).toHaveLength(1)
	})

	it('a drovr POST answers 202 without Kit while the cron is sending the row', async () => {
		const { repository, contactId, config } = await seeded()
		const kit = heldKit()
		const posted = await acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
		})
		if (posted.status !== 'accepted') throw new Error('expected accepted')
		const cron = executePendingValuePathEmailIntents({
			repository,
			emailListProvider: kit.provider as never,
			config,
		})
		await tick()
		expect(kit.calls).toHaveLength(1)

		const reask = await acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
			sendNow: (row) =>
				executeValuePathEmailIntent({
					repository,
					emailListProvider: kit.provider as never,
					intent: row,
					config,
				}),
		})
		expect(reask).toMatchObject({
			status: 'accepted',
			intentId: posted.intentId,
		})
		expect(kit.calls).toHaveLength(1)
		kit.release()
		expect(await cron).toMatchObject([{ status: 'completed' }])
		expect(kit.calls).toHaveLength(1)
	})

	it('the cron hands its claim back when Kit took the email but the completion write threw', async () => {
		const { repository, contactId, config } = await seeded()
		const posted = await acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
		})
		if (posted.status !== 'accepted') throw new Error('expected accepted')
		const result = await executePendingValuePathEmailIntents({
			repository: {
				...bind(repository),
				// Kit took the email; recording it failed once.
				finishClaimedSideEffectIntent: (id, claimedAt, patch) => {
					if (patch.status === 'completed') {
						throw new Error('database write failed')
					}
					return repository.finishClaimedSideEffectIntent(id, claimedAt, patch)
				},
			},
			emailListProvider: {
				subscribeToList: async () => ({ id: 'kit-1' }),
			} as never,
			config,
		})
		expect(result).toEqual([
			{
				status: 'retryable-failed',
				intentId: posted.intentId,
				reviewReasons: [KIT_ACCEPTED_COMPLETION_WRITE_FAILED],
			},
		])
		// Not stranded as sending: the next run re-adds (a no-op) and records it.
		expect(repository.sideEffectIntents.get(posted.intentId)?.status).toBe(
			'pending',
		)
	})

	it('a no-write run takes no claim and leaves the row as it found it', async () => {
		const { repository, contactId, config } = await seeded()
		const posted = await acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
		})
		if (posted.status !== 'accepted') throw new Error('expected accepted')
		const claim = vi.spyOn(repository, 'claimSideEffectIntentForSend')
		const result = await executePendingValuePathEmailIntents({
			repository,
			emailListProvider: { subscribeToList: vi.fn() } as never,
			config: { ...config, allowWrite: false },
		})
		expect(result).toMatchObject([{ status: 'planned' }])
		expect(claim).not.toHaveBeenCalled()
		expect(repository.sideEffectIntents.get(posted.intentId)?.status).toBe(
			'pending',
		)
	})
})

describe('value-path send claim: a sender that outlives its claim', () => {
	it('cannot overwrite the row a newer sender reclaimed', async () => {
		const { repository, contactId, config } = await seeded()
		const kit = heldKit()
		const posted = await acceptDrovrIntent({
			repository,
			intent: drovrIntent(contactId),
		})
		if (posted.status !== 'accepted') throw new Error('expected accepted')
		const cron = executePendingValuePathEmailIntents({
			repository,
			emailListProvider: kit.provider as never,
			config,
		})
		await tick()
		// The claim went stale and another sender took the row.
		const reclaimedAt = new Date(Date.now() + 60_000).toISOString()
		const held = repository.sideEffectIntents.get(posted.intentId)!
		expect(held.status).toBe('sending')
		repository.sideEffectIntents.set(posted.intentId, {
			...held,
			metadata: { ...held.metadata, claimedAt: reclaimedAt },
		})
		kit.release()
		expect(await cron).toEqual([
			{
				status: 'skipped',
				intentId: posted.intentId,
				reviewReasons: [SEND_CLAIM_LOST],
			},
		])
		// The newer sender's claim stands; the stale owner wrote nothing.
		expect(repository.sideEffectIntents.get(posted.intentId)).toMatchObject({
			status: 'sending',
			metadata: { claimedAt: reclaimedAt },
		})
	})

	it('goes stale only after every sender that could hold it has been stopped', () => {
		const maxDurationSeconds = (route: string) => {
			const source = readFileSync(
				join(__dirname, '../../app/api', route, 'route.ts'),
				'utf8',
			)
			const match = source.match(/export const maxDuration = (\d+)/)
			if (!match) throw new Error(`${route} sets no maxDuration`)
			return Number(match[1])
		}
		// The cron sends from /api/inngest; drovr's POST and its after() from
		// /api/drovr/intents. A live sender is never reclaimed underneath itself.
		expect(VALUE_PATH_SEND_CLAIM_STALE_MS).toBeGreaterThan(
			maxDurationSeconds('inngest') * 1000,
		)
		expect(VALUE_PATH_SEND_CLAIM_STALE_MS).toBeGreaterThan(
			maxDurationSeconds('drovr/intents') * 1000,
		)
	})
})

/** The repository's methods as an object a test can override one of. */
function bind(repository: InMemorySubscriberMarketingRepository) {
	return {
		findPendingValuePathEmailSideEffectIntents:
			repository.findPendingValuePathEmailSideEffectIntents.bind(repository),
		findContactById: repository.findContactById.bind(repository),
		findCurrentContactState:
			repository.findCurrentContactState.bind(repository),
		updateSideEffectIntent: repository.updateSideEffectIntent.bind(repository),
		claimSideEffectIntentForSend:
			repository.claimSideEffectIntentForSend.bind(repository),
		finishClaimedSideEffectIntent:
			repository.finishClaimedSideEffectIntent.bind(repository),
	}
}
