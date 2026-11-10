import { Schema } from 'effect'

/**
 * A pointer to what the agent can do next. `tool` and `arguments` name a
 * capability call; `href` names a page or endpoint. Agents read these the way
 * a person reads links: they are the map of the surface, carried in every
 * response so no agent has to guess.
 */
export const NextAction = Schema.Struct({
	description: Schema.String,
	tool: Schema.optionalKey(Schema.String),
	arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	href: Schema.optionalKey(Schema.String),
})
export type NextAction = typeof NextAction.Type

export const NextActions = Schema.Array(NextAction)

export const nextTool = (
	tool: string,
	description: string,
	args?: Record<string, unknown>,
): NextAction =>
	args ? { description, tool, arguments: args } : { description, tool }

export const nextHref = (href: string, description: string): NextAction => ({
	description,
	href,
})
