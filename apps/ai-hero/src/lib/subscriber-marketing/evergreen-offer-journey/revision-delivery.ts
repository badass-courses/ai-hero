import { Effect } from 'effect'
import { z } from 'zod'
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
	type OriginalDeliveryMappingReader,
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
export type ReviewedDeliveryBundle = {
	readonly manifest: DeliveryRevisionScopeData
	readonly providerReadbacks: readonly z.infer<typeof readbackSchema>[]
	readonly originalMapping: OriginalDeliveryMappingReader | null
}
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
	let valid = input.bundles.length <= 2
	for (const candidate of input.bundles) {
		const parsed = bundleSchema.safeParse({
			manifest: candidate.manifest,
			providerReadbacks: candidate.providerReadbacks,
		})
		if (!parsed.success) {
			valid = false
			break
		}
		const bundle = freezeRevision(parsed.data)
		const keys = new Set(bundle.providerReadbacks.map((r) => r.sequenceId))
		if (
			keys.size !== 8 ||
			bundle.manifest.messages.some((m) => !keys.has(m.sequenceId)) ||
			entries.some(
				(e) =>
					JSON.stringify(e.manifest.revision) ===
					JSON.stringify(bundle.manifest.revision),
			)
		) {
			valid = false
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
			},
			delivery: port,
			reconciliation: createKitMembershipReconciliation({
				port,
				clock: deps.clock,
			}),
		})
		entries.push({
			key: JSON.stringify([
				bundle.manifest.revision,
				bundle.manifest.bindingArtifactSha256,
				bundle.manifest.bindingEvidenceId,
			]),
			manifest: bundle.manifest,
			executor,
		})
	}
	if (!valid) entries.length = 0
	const select = (target: MessageExecutionTarget) =>
		Effect.gen(function* () {
			const id = parseJourneyId(target.journeyId)
			if (!id.ok) return null
			const snapshot = yield* deps.ledger.load(id.value)
			if (!snapshot) return null
			const key = JSON.stringify(revisionOf(snapshot.definition))
			return (
				entries.find((e) => JSON.stringify(e.manifest.revision) === key) ?? null
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
	return { execute, preview, settleRecordedOutcomes, reconcileHeld }
}
