import { isValuePathIntentCompleted } from './value-path-completion'
import { isTerminalSkillsWorkflowEmailResourceId } from './skills-workflow-path'
import { evaluateValuePathMovement } from './value-path-run-state'

/** Status-only projection. Never pass this to the repair classifier. */
export type GateDStatusIntent = {
	id: string
	contactId: string
	status: string
	createdAt: string | Date
	completedAt?: string | Date | null
	metadata: Record<string, unknown>
	reviewReasons: string[]
}
export type GateDStatusEvent = {
	contactId: string
	eventType: string
	occurredAt: string | Date
}
export type GateDStatusPage = {
	intents: GateDStatusIntent[]
	events: GateDStatusEvent[]
}
export type GateDStatusRepository = {
	findGateDStatusPages(contactIds: string[]): AsyncIterable<GateDStatusPage>
}

type ContactSummary = {
	contactId: string
	completedPath: boolean
	lastEmailResourceId?: unknown
	lastKitSequenceId?: unknown
	lastStatus?: string
	answerClicks: number
	drips: number
	blocked: Array<{
		intentId: string
		emailResourceId: unknown
		kitSequenceId: unknown
		reviewReasons: string[]
	}>
}

/** One visit per input row; retained history is only the public status output. */
export async function summarizeGateDStatus(args: {
	repository: GateDStatusRepository
	contactIds: string[]
	now: string
}) {
	const byId = new Map<string, ContactSummary>(
		args.contactIds.map((contactId) => [
			contactId,
			{
				contactId,
				completedPath: false,
				answerClicks: 0,
				drips: 0,
				blocked: [],
			},
		]),
	)
	const latest = new Map<string, { at: number; id: string }>()
	const blockedOrder = new Map<string, number>()
	const grouped: Record<string, number> = {}
	const eventTypes: Record<string, number> = {}
	const persistedBlockedReasons: Record<string, number> = {}
	const retrying = {
		retryableDue: 0,
		retryableWaiting: 0,
		nextRetryAt: undefined as string | undefined,
		hardFailed: 0,
		hardFailedReasons: {} as Record<string, number>,
	}
	const totals = {
		contacts: args.contactIds.length,
		intents: 0,
		pending: 0,
		completed: 0,
		blocked: 0,
		stale: 0,
	}
	let lastMovementAt: string | undefined
	function movement(intents: GateDStatusIntent[], events: GateDStatusEvent[]) {
		const at = evaluateValuePathMovement({
			intents,
			events,
			participants: 0,
			completedPathCount: 0,
			now: args.now,
		}).lastMovementAt
		if (at && (!lastMovementAt || at > lastMovementAt)) lastMovementAt = at
	}
	for await (const page of args.repository.findGateDStatusPages(
		args.contactIds,
	)) {
		movement(page.intents, page.events)
		for (const intent of page.intents) {
			const contact = byId.get(intent.contactId)
			if (!contact)
				throw new Error('Gate D reader returned an out-of-scope intent')
			const complete = isValuePathIntentCompleted(intent)
			totals.intents++
			if (complete) totals.completed++
			if (!complete && intent.status === 'pending') totals.pending++
			if (intent.status === 'blocked') totals.blocked++
			if (intent.status === 'stale') totals.stale++
			increment(
				grouped,
				`${complete ? 'completed' : intent.status}:${intent.metadata.emailResourceId}:${intent.metadata.kitSequenceId}`,
			)
			if (
				complete &&
				isTerminalSkillsWorkflowEmailResourceId(
					String(intent.metadata.emailResourceId ?? ''),
				)
			)
				contact.completedPath = true
			const prior = latest.get(intent.contactId)
			const at = new Date(intent.createdAt).getTime()
			if (
				!prior ||
				at > prior.at ||
				(at === prior.at && intent.id > prior.id)
			) {
				latest.set(intent.contactId, { at, id: intent.id })
				contact.lastEmailResourceId = intent.metadata.emailResourceId
				contact.lastKitSequenceId = intent.metadata.kitSequenceId
				contact.lastStatus = intent.status
			}
			if (intent.status === 'blocked') {
				blockedOrder.set(intent.id, at)
				contact.blocked.push({
					intentId: intent.id,
					emailResourceId: intent.metadata.emailResourceId,
					kitSequenceId: intent.metadata.kitSequenceId,
					reviewReasons: intent.reviewReasons,
				})
				for (const reason of intent.reviewReasons)
					increment(persistedBlockedReasons, reason)
			}
			if (!complete && intent.status === 'failed') {
				if (intent.metadata.retryable === true) {
					const next =
						typeof intent.metadata.nextRetryAt === 'string' &&
						intent.metadata.nextRetryAt.length
							? intent.metadata.nextRetryAt
							: undefined
					if (!next || next <= args.now) retrying.retryableDue++
					else {
						retrying.retryableWaiting++
						if (!retrying.nextRetryAt || next < retrying.nextRetryAt)
							retrying.nextRetryAt = next
					}
				} else {
					retrying.hardFailed++
					for (const reason of intent.reviewReasons)
						increment(retrying.hardFailedReasons, reason)
				}
			}
		}
		for (const event of page.events) {
			const contact = byId.get(event.contactId)
			if (!contact)
				throw new Error('Gate D reader returned an out-of-scope event')
			increment(eventTypes, event.eventType)
			if (event.eventType === 'value-path.answer-selected')
				contact.answerClicks++
			if (event.eventType === 'value-path.drip-progressed') contact.drips++
		}
	}
	const byContact = [...byId.values()]
	const currentStepDistribution: Record<string, number> = {}
	let completedPathCount = 0
	for (const contact of byContact) {
		contact.blocked.sort(
			(a, b) =>
				(blockedOrder.get(a.intentId) ?? 0) -
					(blockedOrder.get(b.intentId) ?? 0) ||
				a.intentId.localeCompare(b.intentId),
		)
		increment(
			currentStepDistribution,
			String(contact.lastEmailResourceId ?? 'none'),
		)
		if (contact.completedPath) completedPathCount++
	}
	return {
		byContact,
		grouped,
		eventTypes,
		totals,
		retrying,
		persistedBlockedReasons,
		currentStepDistribution,
		completedPathCount,
		movement: evaluateValuePathMovement({
			intents: [],
			events: lastMovementAt
				? [{ eventType: 'value-path.entered', occurredAt: lastMovementAt }]
				: [],
			participants: args.contactIds.length,
			completedPathCount,
			now: args.now,
		}),
	}
}

function increment(counts: Record<string, number>, key: string) {
	Object.defineProperty(counts, key, {
		value: (Object.hasOwn(counts, key) ? counts[key]! : 0) + 1,
		writable: true,
		enumerable: true,
		configurable: true,
	})
}
