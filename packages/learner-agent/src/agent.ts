import { Effect } from 'effect'

import { capabilities } from './capabilities.js'
import type { RequirementsOf } from './contract.js'
import type { LearnerAgentPorts } from './ports.js'
import { COMPANION_RULES, prompts } from './prompts.js'
import { toToolCatalog } from './projections/catalog.js'
import { handleHttpRequest } from './projections/http.js'
import { invoke, type InvokeResult } from './projections/invoke.js'
import {
	handleMcpRequest,
	toolList,
	type McpServerInfo,
} from './projections/mcp.js'
import { toOpenApi, type OpenApiOptions } from './projections/openapi.js'
import { servicesFor, type LearnerServices } from './services.js'

type Requirements = RequirementsOf<typeof capabilities> | LearnerServices

export const SERVER_INFO: McpServerInfo = {
	name: 'ai-hero-learner',
	title: 'AI Hero',
	version: '1.0.0',
	instructions: [
		'Tools for an AI Hero learner, signed in as themselves. Start with my_courses, then course_outline, then read_lesson or the start_lesson prompt.',
		...COMPANION_RULES,
	].join('\n'),
}

/**
 * The learner agent for one request. Build it at the route with that
 * request's ports, call one handler, and drop it: each call runs its own
 * Effect runtime over the ports and nothing outlives the request.
 */
export function makeLearnerAgent(ports: LearnerAgentPorts) {
	const services = servicesFor(ports)

	const run = async <
		A extends { readonly results: ReadonlyArray<InvokeResult> },
	>(
		program: Effect.Effect<A, never, Requirements>,
	): Promise<A> => {
		const value = await Effect.runPromise(
			program.pipe(Effect.provideContext(services)),
		)
		for (const result of value.results) {
			if (result._tag === 'Defect')
				ports.onDefect?.(result.capability, result.cause)
		}
		return value
	}

	return {
		/**
		 * POST /mcp: one JSON-RPC message or a batch. Pass `signInChallenge`
		 * for an anonymous caller to answer learner-only calls with 401.
		 */
		handleMcp: async (
			request: Request,
			options: { readonly signInChallenge?: string } = {},
		): Promise<Response> =>
			(
				await run(
					handleMcpRequest<Requirements>(
						{
							capabilities,
							prompts,
							server: SERVER_INFO,
							signInChallenge: options.signInChallenge,
						},
						request,
					),
				)
			).response,

		/** GET or POST /api/learner/<capability>. */
		handleHttp: async (
			request: Request,
			capability: string,
		): Promise<Response> =>
			(
				await run(
					handleHttpRequest<Requirements>(
						capabilities,
						request,
						capability,
					).pipe(
						Effect.map((handled) => ({
							response: handled.response,
							results: handled.result ? [handled.result] : [],
						})),
					),
				)
			).response,

		/** One capability call, for scripts and tests. */
		invoke: async (capability: string, input: unknown): Promise<InvokeResult> =>
			(
				await run(
					invoke<Requirements>(capabilities, capability, input).pipe(
						Effect.map((result) => ({ result, results: [result] })),
					),
				)
			).result,
	}
}

export type LearnerAgent = ReturnType<typeof makeLearnerAgent>

/** OpenAPI paths for the HTTP projection; needs no ports. */
export const learnerOpenApi = (options: OpenApiOptions) =>
	toOpenApi(capabilities, options)

/** The tool and prompt catalog; needs no ports. */
export const learnerCatalog = () => toToolCatalog(capabilities, prompts)

/** The MCP `tools/list` entries; needs no ports. */
export const learnerTools = () => toolList(capabilities)
