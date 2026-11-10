import { Data } from 'effect'
import type { Effect, Schema } from 'effect'

/**
 * Honest behaviour flags, projected to MCP tool annotations and OpenAPI.
 * `readOnly` capabilities are also served over GET.
 */
export interface Annotations {
	readonly readOnly: boolean
	readonly destructive: boolean
	readonly idempotent: boolean
	readonly openWorld: boolean
}

/** A schema that needs no services to decode or encode. */
export type PlainSchema = Schema.Top & {
	readonly DecodingServices: never
	readonly EncodingServices: never
}

export type InputSchema = Schema.Struct<Record<string, PlainSchema>>

/**
 * One named learner action: its input, output, expected failures and flags.
 * Every surface (MCP, HTTP, OpenAPI, the catalog) is derived from these
 * schemas; no surface declares its own shapes.
 */
export interface Contract<
	Name extends string,
	Input extends InputSchema,
	Output extends PlainSchema,
	Failure extends PlainSchema,
> {
	readonly _tag: 'Contract'
	readonly name: Name
	readonly title: string
	readonly description: string
	readonly input: Input
	readonly output: Output
	readonly failure: Failure
	readonly annotations: Annotations
}

export type AnyContract = Contract<
	string,
	InputSchema,
	PlainSchema,
	PlainSchema
>

export interface Capability<C extends AnyContract, R = never> {
	readonly _tag: 'Capability'
	readonly contract: C
	readonly handler: (
		input: C['input']['Type'],
	) => Effect.Effect<C['output']['Type'], C['failure']['Type'], R>
}

/**
 * A capability with its handler channels erased. Projections iterate a
 * heterogeneous tuple of these; `RequirementsOf` recovers the services.
 */
export interface AnyCapability {
	readonly _tag: 'Capability'
	readonly contract: AnyContract
	readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>
}

export type RequirementsOf<Caps extends ReadonlyArray<AnyCapability>> =
	Caps[number] extends infer C
		? C extends Capability<AnyContract, infer R>
			? R
			: never
		: never

const defaultAnnotations: Annotations = {
	readOnly: false,
	destructive: false,
	idempotent: false,
	openWorld: false,
}

class ContractRecord extends Data.TaggedClass('Contract')<
	Omit<AnyContract, '_tag'>
> {}

export function defineContract<
	const Name extends string,
	Input extends InputSchema,
	Output extends PlainSchema,
	Failure extends PlainSchema,
>(
	name: Name,
	options: {
		readonly title: string
		readonly description: string
		readonly input: Input
		readonly output: Output
		readonly failure: Failure
		readonly annotations?: Partial<Annotations>
	},
): Contract<Name, Input, Output, Failure> {
	const record = new ContractRecord({
		name,
		title: options.title,
		description: options.description,
		input: options.input,
		output: options.output,
		failure: options.failure,
		annotations: { ...defaultAnnotations, ...options.annotations },
	})
	// SAFETY: the record carries exactly the schemas passed in; the generic
	// parameters restore their precise types, which the tagged record erases.
	return record as unknown as Contract<Name, Input, Output, Failure>
}

class CapabilityRecord extends Data.TaggedClass('Capability')<
	Omit<AnyCapability, '_tag'>
> {}

/** Binds a contract to its one handler. */
export function implement<C extends AnyContract, R = never>(
	contract: C,
	handler: (
		input: C['input']['Type'],
	) => Effect.Effect<C['output']['Type'], C['failure']['Type'], R>,
): Capability<C, R> {
	const record = new CapabilityRecord({
		contract,
		handler: handler as AnyCapability['handler'],
	})
	// SAFETY: as for `defineContract`: the record holds this handler, and the
	// generic parameters restore the channels the heterogeneous record erases.
	return record as unknown as Capability<C, R>
}
