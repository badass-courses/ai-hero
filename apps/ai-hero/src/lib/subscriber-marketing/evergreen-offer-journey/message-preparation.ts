import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { setup, getInitialSnapshot, getNextSnapshot } from 'xstate'
import {
	deliveryRevisionSchema,
	revisionOf,
	type DeliveryRevision,
} from './revision-scope'
import { EVERGREEN_OFFER_JOURNEY_V3 } from './definition'

export const MESSAGE_PREPARATION_EVENT =
	'evergreen.message_preparation.v1' as const
export const preparationHash = (value: string) =>
	createHash('sha256').update(value).digest('hex')
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().min(1).max(255)
const dynamicTokens = [
	'FIRST_NAME',
	'REGULAR_PRICE',
	'DISCOUNT_AMOUNT',
	'DEADLINE_DISPLAY',
] as const
const linkTokens = [
	'OFFER_URL',
	'REWIRED_BRAIN_URL',
	'FEATURE_BUILD_URL',
	'GENERAL_FAQ_URL',
	'TEAM_URL',
	'ICEBERG_IMAGE_URL',
	'WORKFLOW_IMAGE_URL',
	'FEATURE_BUILD_IMAGE_URL',
	'FAQ_TESTIMONIAL_IMAGE_URL',
] as const
export type DynamicMessageToken = (typeof dynamicTokens)[number]
export type MessageLinkToken = (typeof linkTokens)[number]
const allowed = new Set<string>([...dynamicTokens, ...linkTokens])
export const preparationRevisionSchema = deliveryRevisionSchema
export function preparationNamespace(revision: DeliveryRevision, slot: string) {
	const r = preparationRevisionSchema.parse(revision)
	if (!/^[BP][1-5]$/.test(slot) || slot === 'B4' || slot === 'B5')
		throw new Error('Invalid message slot')
	return `aih_${preparationHash(JSON.stringify([r.definitionVersion, r.messagePlanId, r.contentRevision, r.messagePlanSourceHash, r.presentationReviewRevision]))}_${slot.toLowerCase()}`
}
export const preparationSnapshotSchema = z
	.object({
		version: z.literal(1),
		namespace: identifier,
		contactId: identifier,
		subscriberId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		providerIdentityId: identifier,
		email: z.string().min(1).max(510),
		journeyId: identifier,
		intentKey: identifier,
		revision: preparationRevisionSchema,
		slot: z.enum(['B1', 'B2', 'B3', 'P1', 'P2', 'P3', 'P4', 'P5']),
		claimToken: z.string().uuid(),
		claimedAt: z.string().datetime(),
		preparedAt: z.string().datetime(),
		notBefore: z.string().datetime(),
		notAfter: z.string().datetime(),
		sourceHash: sha,
		htmlHash: sha,
		renderedHash: sha,
		liquidHash: sha,
		subjectHash: sha,
		linksHash: sha,
		fields: z
			.record(z.string().min(1).max(160), z.string().max(4096))
			.refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 4),
		authority: z
			.object({
				publicPriceId: identifier.optional(),
				publicPriceCents: z.number().int().nonnegative().optional(),
				couponId: identifier.optional(),
				amountOffCents: z.literal(10000).optional(),
				expiresAt: z.string().datetime().optional(),
				timeZone: z.string().min(1).max(100).optional(),
			})
			.strict(),
	})
	.strict()
	.superRefine((s, ctx) => {
		const has = (token: DynamicMessageToken) =>
			`${s.namespace}_${token.toLowerCase()}` in s.fields
		if (
			(has('REGULAR_PRICE') &&
				(!s.authority.publicPriceId ||
					s.authority.publicPriceCents === undefined)) ||
			(has('DISCOUNT_AMOUNT') &&
				(!s.authority.couponId || s.authority.amountOffCents !== 10000)) ||
			(has('DEADLINE_DISPLAY') &&
				(!s.authority.couponId ||
					!s.authority.expiresAt ||
					!s.authority.timeZone))
		)
			ctx.addIssue({ code: 'custom', message: 'Missing token authority' })
		if (
			Date.parse(s.notAfter) <= Date.parse(s.notBefore) ||
			Date.parse(s.preparedAt) < Date.parse(s.notBefore) ||
			Date.parse(s.preparedAt) >= Date.parse(s.notAfter)
		)
			ctx.addIssue({ code: 'custom', message: 'Invalid preparation window' })
		if (
			s.namespace !== preparationNamespace(s.revision, s.slot) ||
			Object.keys(s.fields).some(
				(k) =>
					!dynamicTokens.some((t) => k === `${s.namespace}_${t.toLowerCase()}`),
			)
		)
			ctx.addIssue({ code: 'custom', message: 'Projection namespace mismatch' })
		if (
			!isDeepStrictEqual(s.revision, revisionOf(EVERGREEN_OFFER_JOURNEY_V3)) ||
			s.sourceHash !== EVERGREEN_OFFER_JOURNEY_V3.messagePlanSourceHash
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Unapproved preparation revision',
			})
	})
export type MessagePreparationSnapshot = z.infer<
	typeof preparationSnapshotSchema
>
export const preparationEventSchema = z
	.object({
		version: z.literal(1),
		stage: z.enum([
			'snapshot',
			'namespace',
			'fields-requested',
			'enrollment-requested',
		]),
		observedAt: z.string().datetime(),
		snapshot: preparationSnapshotSchema,
	})
	.strict()
	.refine(
		(v) => Date.parse(v.observedAt) >= Date.parse(v.snapshot.preparedAt),
		'Marker predates snapshot',
	)
export type PreparationStage = z.infer<typeof preparationEventSchema>['stage']
export function preparationKey(s: MessagePreparationSnapshot) {
	return preparationHash(
		JSON.stringify(['message-preparation', s.subscriberId, s.namespace]),
	)
}
export const escapeMessageValue = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				c
			]!,
	)
export function checkedMessageUrl(
	raw: string,
	reviewedToken?: MessageLinkToken,
): string {
	const u = new URL(raw)
	const reviewedAsset =
		reviewedToken !== undefined &&
		(linkTokens as readonly string[]).includes(reviewedToken) &&
		reviewedToken.endsWith('_IMAGE_URL')
	if (
		u.protocol !== 'https:' ||
		u.username ||
		u.password ||
		u.hash ||
		(u.search && !reviewedAsset) ||
		u.href !== raw
	)
		throw new Error('Unreviewable message URL')
	return raw
}
export type ReviewedMessageTemplate = Readonly<{
	revision: DeliveryRevision
	slot: MessagePreparationSnapshot['slot']
	sourceHash: string
	subject: string
	html: string
	htmlHash: string
	subjectHash: string
	links: Partial<Record<MessageLinkToken, string>>
}>
/** Trusted reviewed HTML only, not a Markdown parser or a prose generator. The
 * owning content repository supplies bodies and exact reviewed hashes at runtime. */
export function compileMessageTemplate(
	template: ReviewedMessageTemplate,
	values: Partial<Record<DynamicMessageToken, string>>,
) {
	if (
		!isDeepStrictEqual(
			template.revision,
			revisionOf(EVERGREEN_OFFER_JOURNEY_V3),
		) ||
		template.sourceHash !== EVERGREEN_OFFER_JOURNEY_V3.messagePlanSourceHash ||
		template.htmlHash !== preparationHash(template.html) ||
		template.subjectHash !== preparationHash(template.subject)
	)
		throw new Error('Unreviewed message body')
	if (
		template.html.length > 100000 ||
		/\{\{|\{%/.test(template.html) ||
		template.subject.length > 500 ||
		/\$[A-Z][A-Z_]+/.test(template.subject)
	)
		throw new Error('Invalid static subject or body bound')
	if (/<script\b|\bon\w+\s*=/i.test(template.html))
		throw new Error('Executable message markup')
	for (const match of template.html.matchAll(
		/\b(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
	)) {
		const attribute = match[1]!
		if (!/^["']/.test(attribute)) throw new Error('Unquoted message URL')
		const url = attribute.slice(1, -1)
		if ((linkTokens as readonly string[]).some((token) => url === `$${token}`))
			continue
		if (!Object.values(template.links).includes(url))
			throw new Error('Unreviewed literal URL')
		const asset = Object.entries(template.links).find(
			([token, value]) => value === url && token.endsWith('_IMAGE_URL'),
		)
		checkedMessageUrl(url, asset?.[0] as MessageLinkToken | undefined)
	}
	const namespace = preparationNamespace(template.revision, template.slot),
		fields: Record<string, string> = {}
	const substitute = (liquid: boolean) =>
		template.html.replace(/\$([A-Z][A-Z_]+)/g, (_, token: string) => {
			if (!allowed.has(token)) throw new Error('Unknown message token')
			if ((linkTokens as readonly string[]).includes(token)) {
				const link = template.links[token as MessageLinkToken]
				if (!link) throw new Error('Missing reviewed link')
				return escapeMessageValue(
					checkedMessageUrl(link, token as MessageLinkToken),
				)
			}
			const raw = values[token as DynamicMessageToken]
			if (raw === undefined || raw.length > 4096)
				throw new Error('Missing trusted message value')
			const key = `${namespace}_${token.toLowerCase()}`
			fields[key] = escapeMessageValue(raw)
			return liquid ? `{{ subscriber.${key} }}` : fields[key]!
		})
	const html = substitute(false),
		liquid = substitute(true)
	if (!Object.keys(fields).length)
		throw new Error('Missing scoped name projection')
	return {
		html,
		liquid,
		fields,
		namespace,
		liquidHash: preparationHash(liquid),
		linksHash: preparationHash(
			JSON.stringify(
				Object.entries(template.links).sort(([a], [b]) => a.localeCompare(b)),
			),
		),
	}
}

export const preparationMachine = setup({
	types: {
		events: {} as {
			type: 'SNAPSHOT' | 'FIELDS' | 'READBACK' | 'ENROLLMENT' | 'HOLD'
		},
	},
}).createMachine({
	id: 'immutable-message-preparation',
	initial: 'unprepared',
	states: {
		unprepared: { on: { SNAPSHOT: 'frozen', HOLD: 'held' } },
		frozen: { on: { FIELDS: 'projection', HOLD: 'held' } },
		projection: { on: { READBACK: 'confirmed', HOLD: 'held' } },
		confirmed: { on: { ENROLLMENT: 'enrollment', HOLD: 'held' } },
		enrollment: { type: 'final' },
		held: { type: 'final' },
	},
})
export function preparationState(
	events: readonly (
		| 'SNAPSHOT'
		| 'FIELDS'
		| 'READBACK'
		| 'ENROLLMENT'
		| 'HOLD'
	)[],
) {
	let state = getInitialSnapshot(preparationMachine)
	for (const type of events)
		state = getNextSnapshot(preparationMachine, state, { type })
	return state.value
}
