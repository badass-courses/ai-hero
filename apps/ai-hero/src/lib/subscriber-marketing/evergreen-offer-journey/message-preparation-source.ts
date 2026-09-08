import { isDeepStrictEqual } from 'node:util'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { contact, providerIdentity, prices, coupon } from '@/db/schema'
import type { EvergreenOfferJourneyDatabase } from './drizzle-ledger'
import type { JourneyLedger } from './ports'
import type { SendMessageIntent } from './domain'
import type { AttemptEvidence } from './attempt-evidence'
import { EVERGREEN_OFFER_PRODUCT_ID } from './domain'
import { revisionOf } from './revision-scope'
import { readCouponEvidence } from './coupon-authority'
import {
	compileMessageTemplate,
	preparationHash,
	preparationSnapshotSchema,
	type ReviewedMessageTemplate,
	type MessagePreparationSnapshot,
	type DynamicMessageToken,
} from './message-preparation'
import { createMessagePreparationGate } from './message-preparation-gate'
import type { MessagePreparationStore } from './message-preparation-store'
import type { MessageFieldsTransport } from './message-preparation-fields'

/** Public Price.unitAmount is decimal dollars in the installed adapter. This is
 * its getPriceForProduct source, NOT formatPricesForProduct's upgrade-adjusted
 * fullPrice, a personalized quote, a checkout handoff, or a default geography. */
function publicCents(value: string) {
	if (!/^\d+\.\d{2}$/.test(value)) throw new Error('Invalid public price')
	const n = Number(value.replace('.', ''))
	if (!Number.isSafeInteger(n) || n <= 0)
		throw new Error('Invalid public price')
	return n
}
const money = (cents: number) =>
	new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: cents % 100 ? 2 : 0,
	}).format(cents / 100)
export function createTrustedMessagePreparation(options: {
	database: Pick<EvergreenOfferJourneyDatabase, 'select'>
	ledger: JourneyLedger
	templates: readonly ReviewedMessageTemplate[]
	store: MessagePreparationStore
	fields: MessageFieldsTransport
	now: () => string
}) {
	const templates = structuredClone(options.templates)
	if (
		templates.length !== 8 ||
		new Set(templates.map((t) => t.slot)).size !== 8
	)
		throw new Error('Eight reviewed preparation templates required')
	const build = async (
		intent: SendMessageIntent,
		evidence: Pick<AttemptEvidence, 'claimToken' | 'claimedAt'>,
		preparedAt = options.now(),
	) => {
		const aggregate = await Effect.runPromise(
			options.ledger.load(intent.journeyId),
		)
		const template = templates.find((t) => t.slot === intent.slotId)
		if (
			!aggregate ||
			aggregate.contactId !== intent.contactId ||
			!template ||
			!isDeepStrictEqual(template.revision, revisionOf(aggregate.definition))
		)
			throw new Error('Preparation revision unavailable')
		const [person] = await options.database
			.select()
			.from(contact)
			.where(eq(contact.id, intent.contactId))
			.limit(1)
		const identities = await options.database
			.select()
			.from(providerIdentity)
			.where(
				and(
					eq(providerIdentity.contactId, intent.contactId),
					eq(providerIdentity.provider, 'kit'),
				),
			)
			.limit(2)
		const identity = identities[0]
		if (
			!person ||
			identities.length !== 1 ||
			!identity ||
			!/^\d+$/.test(identity.externalId)
		)
			throw new Error('Preparation identity unavailable')
		const subscriberId = Number(identity.externalId)
		if (!Number.isSafeInteger(subscriberId) || subscriberId <= 0)
			throw new Error('Invalid subscriber')
		const values: Partial<Record<DynamicMessageToken, string>> = {
			FIRST_NAME: person.name?.trim().split(/\s+/)[0] || 'there',
		}
		const authority: MessagePreparationSnapshot['authority'] = {}
		if (template.html.includes('$REGULAR_PRICE')) {
			const rows = await options.database
				.select()
				.from(prices)
				.where(eq(prices.productId, EVERGREEN_OFFER_PRODUCT_ID))
				.limit(2)
			if (rows.length !== 1 || !rows[0])
				throw new Error('Public price unavailable or ambiguous')
			authority.publicPriceId = rows[0].id
			authority.publicPriceCents = publicCents(rows[0].unitAmount)
			values.REGULAR_PRICE = money(authority.publicPriceCents)
		}
		if (
			template.html.includes('$DISCOUNT_AMOUNT') ||
			template.html.includes('$DEADLINE_DISPLAY')
		) {
			const issued = aggregate.coupon
			if (!issued) throw new Error('Issued coupon unavailable')
			const [actual] = await options.database
				.select()
				.from(coupon)
				.where(eq(coupon.id, issued.couponId))
				.limit(1)
			if (
				!actual ||
				actual.status !== 1 ||
				actual.usedCount !== 0 ||
				actual.amountDiscount !== 10000 ||
				actual.restrictedToProductId !== EVERGREEN_OFFER_PRODUCT_ID ||
				actual.expires?.toISOString() !== issued.expiresAt ||
				Date.parse(options.now()) >= Date.parse(issued.expiresAt) ||
				issued.terms.amountOffCents !== 10000
			)
				throw new Error('Coupon terms unavailable')
			if (!isDeepStrictEqual(readCouponEvidence(actual).coupon, issued))
				throw new Error('Coupon ownership changed')
			authority.couponId = issued.couponId
			authority.amountOffCents = 10000
			authority.expiresAt = issued.expiresAt
			authority.timeZone = issued.deadlineTimeZone.timeZone
			values.DISCOUNT_AMOUNT = money(actual.amountDiscount)
			values.DEADLINE_DISPLAY = new Intl.DateTimeFormat('en-US', {
				timeZone: authority.timeZone,
				weekday: 'long',
				year: 'numeric',
				month: 'long',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
				second: '2-digit',
				timeZoneName: 'long',
			}).format(new Date(issued.expiresAt))
		}
		const compiled = compileMessageTemplate(template, values)
		return preparationSnapshotSchema.parse({
			version: 1,
			namespace: compiled.namespace,
			contactId: person.id,
			subscriberId,
			providerIdentityId: identity.id,
			email: person.email,
			journeyId: intent.journeyId,
			intentKey: intent.idempotencyKey,
			revision: template.revision,
			slot: template.slot,
			claimToken: evidence.claimToken,
			claimedAt: evidence.claimedAt.toISOString(),
			preparedAt,
			notBefore: intent.notBefore,
			notAfter: intent.notAfter,
			sourceHash: template.sourceHash,
			htmlHash: template.htmlHash,
			renderedHash: preparationHash(compiled.html),
			liquidHash: compiled.liquidHash,
			subjectHash: template.subjectHash,
			linksHash: compiled.linksHash,
			fields: compiled.fields,
			authority,
		})
	}
	return createMessagePreparationGate({
		store: options.store,
		fields: options.fields,
		build,
		current: async (snapshot, intent) =>
			isDeepStrictEqual(
				snapshot,
				await build(
					intent,
					{
						claimToken: snapshot.claimToken,
						claimedAt: new Date(snapshot.claimedAt),
					},
					snapshot.preparedAt,
				),
			),
	})
}
