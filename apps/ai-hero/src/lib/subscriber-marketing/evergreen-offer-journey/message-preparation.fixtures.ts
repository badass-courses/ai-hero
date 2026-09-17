import { EVERGREEN_OFFER_JOURNEY_V3 } from './definition'
import { revisionOf } from './revision-scope'
import { syntheticRevisionScope } from './revision-delivery.fixtures'
import { fixtureEntry } from './bounded-readers.fixtures'
import { decideEvergreenOfferJourney } from './decision'
import type { JourneyLedgerCommit } from './ports'
import type { SendMessageIntent } from './domain'
import type { StimulusId } from './primitives'
import {
	compileMessageTemplate,
	preparationHash,
	preparationSnapshotSchema,
	type ReviewedMessageTemplate,
} from './message-preparation'

export function preparationFixture() {
	const definition = EVERGREEN_OFFER_JOURNEY_V3,
		original = fixtureEntry('preparation-fixture')
	const admitted = decideEvergreenOfferJourney({
		snapshot: null,
		stimulus: original.stimulus,
		currentFacts: original.currentFacts,
		definition,
		now: original.decidedAt,
	})
	if (!admitted.ok || admitted.decision.type !== 'Accepted')
		throw new Error('Fixture admission')
	const entry: JourneyLedgerCommit = {
		...original,
		definition,
		decision: admitted.decision,
	}
	const w = entry.decision.wakeIntents[0]!
	const stimulus = {
		type: 'WakeDue' as const,
		stimulusId: 'prep-wake' as StimulusId,
		journeyId: entry.decision.next.journeyId,
		wakeId: w.wakeId,
		purpose: w.purpose,
		dueAt: w.dueAt,
	}
	const currentFacts = {
		...entry.currentFacts,
		existingJourneyId: entry.decision.next.journeyId,
		readAt: w.dueAt,
	}
	const awakened = decideEvergreenOfferJourney({
		snapshot: entry.decision.next,
		stimulus,
		currentFacts,
		definition,
		now: w.dueAt,
	})
	if (!awakened.ok || awakened.decision.type !== 'Accepted')
		throw new Error('Fixture wake')
	const wake: JourneyLedgerCommit = {
		stimulus,
		currentFacts,
		definition,
		expectedVersion: entry.decision.next.version,
		decidedAt: w.dueAt,
		decision: awakened.decision,
	}
	const intent = wake.decision.sideEffectIntents.find(
		(i): i is SendMessageIntent => i.type === 'SendMessage',
	)!
	const templates: ReviewedMessageTemplate[] = [
		'B1',
		'B2',
		'B3',
		'P1',
		'P2',
		'P3',
		'P4',
		'P5',
	].map((slot) => {
		const html = slot.startsWith('B')
			? '<p>Hello $FIRST_NAME. <a href="$OFFER_URL">Synthetic account link</a></p>'
			: '<p>Hello $FIRST_NAME. Public $REGULAR_PRICE; coupon $DISCOUNT_AMOUNT until $DEADLINE_DISPLAY. <a href="$OFFER_URL">Synthetic account link</a></p>'
		return {
			revision: revisionOf(definition),
			slot: slot as ReviewedMessageTemplate['slot'],
			sourceHash: definition.messagePlanSourceHash,
			subject: 'Synthetic preparation fixture',
			subjectHash: preparationHash('Synthetic preparation fixture'),
			html,
			htmlHash: preparationHash(html),
			links: { OFFER_URL: 'https://example.test/account' },
		}
	})
	const manifest = syntheticRevisionScope(definition).manifest
	manifest.messages = manifest.messages.map((m) => ({
		...m,
		bodySha256: compileMessageTemplate(
			templates.find((t) => t.slot === m.slotId)!,
			{
				FIRST_NAME: 'there',
				REGULAR_PRICE: '$299',
				DISCOUNT_AMOUNT: '$100',
				DEADLINE_DISPLAY: 'synthetic',
			},
		).liquidHash,
	}))
	const c = compileMessageTemplate(templates[0]!, { FIRST_NAME: 'there' })
	const snapshot = preparationSnapshotSchema.parse({
		version: 1,
		namespace: c.namespace,
		contactId: intent.contactId,
		subscriberId: 123,
		providerIdentityId: 'kit-prep-fixture',
		email: 'synthetic@example.test',
		journeyId: intent.journeyId,
		intentKey: intent.idempotencyKey,
		revision: revisionOf(definition),
		slot: 'B1',
		claimToken: '00000000-0000-4000-8000-000000000001',
		claimedAt: wake.decidedAt,
		preparedAt: wake.decidedAt,
		notBefore: intent.notBefore,
		notAfter: intent.notAfter,
		sourceHash: definition.messagePlanSourceHash,
		htmlHash: templates[0]!.htmlHash,
		renderedHash: preparationHash(c.html),
		liquidHash: c.liquidHash,
		subjectHash: templates[0]!.subjectHash,
		linksHash: c.linksHash,
		fields: c.fields,
		authority: {},
	})
	return {
		entry,
		wake,
		intent,
		now: wake.decidedAt,
		templates,
		manifest,
		snapshot,
	}
}
