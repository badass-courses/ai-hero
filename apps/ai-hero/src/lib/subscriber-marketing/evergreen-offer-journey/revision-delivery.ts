import { isDeepStrictEqual } from 'node:util'
import {
	EVERGREEN_OFFER_JOURNEY_V1,
	EVERGREEN_OFFER_JOURNEY_V2,
	EVERGREEN_OFFER_JOURNEY_V3,
} from './definition'
import { Effect } from 'effect'
import { z } from 'zod'
import { normalizeEmail } from '../contact-email-equivalence'
import { createKitDeliveryPort, type KitDeliveryOptions } from './kit-delivery'
import {
	createMessageIntentExecutor,
	createKitMembershipReconciliation,
	type MessageExecutorDependencies,
	type MessageExecutionTarget,
	type MessageIntentExecutor,
} from './message-executor'
import {
	captureRevisionScope,
	freezeRevision,
	revisionOf,
	revisionScopeDataSchema,
	type DeliveryRevisionScopeData,
	type DeliveryRevision,
	type OriginalDeliveryMappingReader,
	type OriginalDeliveryMappingWriter,
} from './revision-scope'
import { parseJourneyId } from './primitives'

const readbackSchema = z
	.object({
		sequenceId: z.number().int().positive(),
		repeat: z.literal(false),
		emailCount: z.literal(1),
		published: z.literal(true),
		active: z.literal(true),
		hold: z.literal(false),
	})
	.strict()
const bundleSchema = z
	.object({
		manifest: revisionScopeDataSchema,
		providerReadbacks: z.array(readbackSchema).length(8),
	})
	.strict()
export { bundleSchema as reviewedDeliveryBundleSchema }

export type ReviewedDeliveryBundle = {
	readonly manifest: DeliveryRevisionScopeData
	readonly providerReadbacks: readonly z.infer<typeof readbackSchema>[]
	readonly originalMapping: OriginalDeliveryMappingReader | null
	readonly mappingWriter?: OriginalDeliveryMappingWriter | null
}
/** Ordered, lossless identity. Property insertion order is not revision identity. */
export function deliveryRevisionKey(revision: DeliveryRevision): string {
	return JSON.stringify([
		revision.definitionVersion,
		revision.messagePlanId,
		revision.contentRevision,
		revision.messagePlanSourceHash,
		revision.presentationReviewRevision,
	])
}
export type DeliveryRegistryStatus = {
	readonly registeredRevisions: readonly Readonly<DeliveryRevision>[]
} & (
	| { readonly type: 'Unconfigured' }
	| { readonly type: 'Configured' }
	| {
			readonly type: 'Invalid'
			readonly reason: 'TooManyBundles' | 'DuplicateRevision' | 'InvalidBundle'
	  }
)

/** Deliberately empty. Content metadata is NOT reviewed provider/body evidence. */
export const PRODUCTION_DELIVERY_BUNDLES: readonly ReviewedDeliveryBundle[] =
	Object.freeze([])

/** Dormant composition. Reviewed artifact provenance is an explicit trusted input,
 * not something this constructor proves by parsing configuration. No live mapping
 * is supplied. A replacement mapping under an existing revision is not supported.
 */
export function createRevisionDelivery(input: {
	readonly bundles: readonly ReviewedDeliveryBundle[]
	readonly dependencies: Omit<
		MessageExecutorDependencies,
		'delivery' | 'reconciliation' | 'revisionScope'
	>
	readonly kit: Omit<KitDeliveryOptions, 'bindings' | 'now'>
	readonly now: () => string
}) {
	const deps = { ...input.dependencies }
	const kit = { ...input.kit }
	const now = input.now
	const entries: {
		key: string
		manifest: DeliveryRevisionScopeData
		executor: MessageIntentExecutor
	}[] = []
	let reason: 'TooManyBundles' | 'DuplicateRevision' | 'InvalidBundle' | null =
		input.bundles.length > 3 ? 'TooManyBundles' : null
	for (const candidate of reason ? [] : input.bundles) {
		const parsed = bundleSchema.safeParse({
			manifest: candidate.manifest,
			providerReadbacks: candidate.providerReadbacks,
		})
		if (!parsed.success) {
			reason = 'InvalidBundle'
			break
		}
		const bundle = freezeRevision(parsed.data)
		if (
			![
				EVERGREEN_OFFER_JOURNEY_V1,
				EVERGREEN_OFFER_JOURNEY_V2,
				EVERGREEN_OFFER_JOURNEY_V3,
			].some((d) => isDeepStrictEqual(revisionOf(d), bundle.manifest.revision))
		) {
			reason = 'InvalidBundle'
			break
		}
		const keys = new Set(bundle.providerReadbacks.map((r) => r.sequenceId))
		if (
			keys.size !== 8 ||
			bundle.manifest.messages.some((m) => !keys.has(m.sequenceId))
		) {
			reason = 'InvalidBundle'
			break
		}
		if (
			entries.some((e) =>
				isDeepStrictEqual(
					revisionOf(e.manifest.revision),
					revisionOf(bundle.manifest.revision),
				),
			)
		) {
			reason = 'DuplicateRevision'
			break
		}
		const port = createKitDeliveryPort({
			...kit,
			now,
			bindings: bundle.manifest.messages.map((m) => ({
				contentResourceId: m.contentResourceId,
				sequenceId: m.sequenceId,
				readback: bundle.providerReadbacks.find(
					(r) => r.sequenceId === m.sequenceId,
				)!,
			})),
		})
		const executor = createMessageIntentExecutor({
			...deps,
			revisionScope: {
				manifest: bundle.manifest,
				originalMapping: candidate.originalMapping,
				mappingWriter: candidate.mappingWriter,
			},
			delivery: bundle.manifest.revision.definitionVersion==='evergreen-offer-v3'?{
				apply:(intent)=>{
					let expected:{subscriberId:number;email:string}|null=null
					return createKitDeliveryPort({...kit,now,bindings:bundle.manifest.messages.map(m=>({contentResourceId:m.contentResourceId,sequenceId:m.sequenceId,readback:bundle.providerReadbacks.find(r=>r.sequenceId===m.sequenceId)!})),
						resolveIdentity:async(contactId)=>{
							expected=await deps.preparation?.identity(intent)??null
							const current=z.object({contactId:z.string(),subscriberId:z.number()}).parse(await kit.resolveIdentity(contactId))
							if(!expected||current.contactId!==intent.contactId||current.subscriberId!==expected.subscriberId)throw new Error('Prepared identity changed')
							return current
						},
						fetch:async(url,init)=>{
							const response=await kit.fetch(url,init)
							if(init?.method==='GET'&&response.status===200){
								const current=z.object({subscriber:z.object({id:z.number(),email_address:z.string()})}).parse(await response.clone().json()).subscriber
								if(!expected||current.id!==expected.subscriberId||normalizeEmail(current.email_address)!==normalizeEmail(expected.email))throw new Error('Prepared provider email changed')
							}
							return response
						},
					}).apply(intent)
				},
			}:port,
			reconciliation: createKitMembershipReconciliation({
				port:
					bundle.manifest.revision.definitionVersion === 'evergreen-offer-v3'
						? {
								reconcile: (intent) =>
									Effect.gen(function* () {
										const allowed = yield* Effect.tryPromise({
											try: () =>
												deps.preparation?.mayReconcile(intent) ??
												Promise.resolve(false),
											catch: () => false,
										}).pipe(Effect.catchAll(() => Effect.succeed(false)))
										if (!allowed)
											return {
												type: 'Unknown' as const,
												reason:
													'Preparation does not prove enrollment was attempted',
											}
										return yield* port.reconcile(intent)
									}),
							}
						: port,
				clock: deps.clock,
			}),
		})
		entries.push({
			// New dormant cursor-key format: ordered tuple key plus artifact identity.
			// No production cursors exist; this is not a live cursor migration.
			key: JSON.stringify([
				deliveryRevisionKey(bundle.manifest.revision),
				bundle.manifest.bindingArtifactSha256,
				bundle.manifest.bindingEvidenceId,
			]),
			manifest: bundle.manifest,
			executor,
		})
	}
	if (reason) entries.length = 0
	const status: DeliveryRegistryStatus = freezeRevision(
		reason
			? { type: 'Invalid', reason, registeredRevisions: [] }
			: {
					type: entries.length ? 'Configured' : 'Unconfigured',
					registeredRevisions: entries.map((e) =>
						revisionOf(e.manifest.revision),
					),
				},
	)
	const select = (target: MessageExecutionTarget) =>
		Effect.gen(function* () {
			const id = parseJourneyId(target.journeyId)
			if (!id.ok) return null
			const snapshot = yield* deps.ledger.load(id.value)
			if (!snapshot) return null
			const key = deliveryRevisionKey(snapshot.definition)
			return (
				entries.find((e) => deliveryRevisionKey(e.manifest.revision) === key) ??
				null
			)
		})
	const execute = (target: MessageExecutionTarget) =>
		Effect.gen(function* () {
			const entry = yield* select(target)
			if (!entry)
				return {
					type: 'NotClaimed',
					reason: 'RevisionUnavailable',
					sideEffects: 'none',
				} as const
			return yield* entry.executor.execute(target)
		})
	const preview = (target: MessageExecutionTarget) =>
		Effect.gen(function* () {
			const entry = yield* select(target)
			const id = parseJourneyId(target.journeyId)
			if (!entry || !id.ok)
				return { type: 'Held', reason: 'RevisionUnavailable' } as const
			const now = yield* deps.clock.now
			const view = yield* deps.ledger.inspect({
				journeyId: id.value,
				now,
				automationControl: 'Stopped',
			})
			const intent = view.intents.find(
				(r) => r.intent.idempotencyKey === target.idempotencyKey,
			)?.intent
			if (
				!intent ||
				intent.type !== 'SendMessage' ||
				captureRevisionScope({
					manifest: entry.manifest,
					originalMapping: null,
				}).check(view.aggregate, intent)
			)
				return { type: 'Held', reason: 'RevisionMismatch' } as const
			return { type: 'Selected', manifest: entry.manifest } as const
		})
	const settleRecordedOutcomes = (request: {
		limit: number
		afterByScope?: Readonly<
			Record<
				string,
				NonNullable<
					Parameters<
						MessageIntentExecutor['settleRecordedOutcomes']
					>[0]['after']
				>
			>
		>
	}) =>
		Effect.gen(function* () {
			if (!entries.length)
				return { type: 'Held', reason: 'RevisionUnavailable' } as const
			const pages = []
			for (const entry of entries)
				pages.push({
					scopeKey: entry.key,
					revision: entry.manifest.revision,
					page: yield* entry.executor.settleRecordedOutcomes({
						limit: request.limit,
						after: request.afterByScope?.[entry.key],
					}),
				})
			return { type: 'Pages', pages } as const
		})
	const reconcileHeld = (request: {
		limit: number
		afterByScope?: Readonly<
			Record<
				string,
				NonNullable<
					Parameters<MessageIntentExecutor['reconcileHeld']>[0]['after']
				>
			>
		>
	}) =>
		Effect.gen(function* () {
			if (!entries.length)
				return { type: 'Held', reason: 'RevisionUnavailable' } as const
			const pages = []
			for (const entry of entries)
				pages.push({
					scopeKey: entry.key,
					revision: entry.manifest.revision,
					page: yield* entry.executor.reconcileHeld({
						limit: request.limit,
						after: request.afterByScope?.[entry.key],
					}),
				})
			return { type: 'Pages', pages } as const
		})
	return {
		registry: () => status,
		execute,
		preview,
		settleRecordedOutcomes,
		reconcileHeld,
	}
}
