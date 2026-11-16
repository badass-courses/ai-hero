/**
 * Retiring the learner agent (the `/mcp` server and `/api/learner/*`) without
 * leaving connected agents with a bare 401 or an empty tool list that looks
 * like a bug.
 *
 * - `active`: everything works as before.
 * - `notice`: everything still works, every tool result carries the notice,
 *   and no new learner connection can start.
 * - `retired`: every tool call answers with the retirement message and a link
 *   to read the same lesson on the site. `initialize` and `tools/list` still
 *   answer, so a client keeps calling and sees the message.
 *
 * Two admin flags pick the stage, so it changes without a deploy. Admin and
 * analytics tokens are a different scope and never pass through here.
 */

export type LearnerAgentStage = 'active' | 'notice' | 'retired'

export function learnerAgentStage(flags: {
	notice: boolean
	retired: boolean
}): LearnerAgentStage {
	if (flags.retired) return 'retired'
	if (flags.notice) return 'notice'
	return 'active'
}

/** New learner connections (OAuth, device flow, learner tokens) start only while active. */
export const learnerSignInOpen = (stage: LearnerAgentStage) =>
	stage === 'active'

/** No em dashes in customer-facing copy (DESIGN.md). */
export const RETIREMENT_COPY = {
	notice:
		'Notice: AI Hero is retiring this connection for coding agents. After that, read your lessons on aihero.dev as usual; your course access does not change.',
	retired: (url: string) =>
		`AI Hero has retired this connection for coding agents, so this tool no longer returns course content. Read it on the site instead: ${url}. Your course access has not changed.`,
	signInClosed:
		'AI Hero is retiring its connection for coding agents, so new connections are closed. Your course access has not changed; read your lessons on aihero.dev.',
} as const

/** Where the learner reads what the tool would have returned. */
export function siteUrlForCall(
	baseUrl: string,
	args: Record<string, unknown> | undefined,
): string {
	const base = baseUrl.replace(/\/+$/, '')
	const slug = (value: unknown) =>
		typeof value === 'string' && /^[A-Za-z0-9~._-]+$/.test(value) ? value : null
	const workshop = slug(args?.workshop)
	const lesson = slug(args?.lesson)
	if (workshop && lesson) return `${base}/workshops/${workshop}/${lesson}`
	if (workshop) return `${base}/workshops/${workshop}`
	return base
}

type JsonRpcMessage = {
	jsonrpc?: unknown
	id?: unknown
	method?: unknown
	params?: { name?: unknown; arguments?: unknown } & Record<string, unknown>
	result?: unknown
	error?: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const isToolCall = (message: unknown): message is JsonRpcMessage =>
	isObject(message) && message.method === 'tools/call' && 'id' in message

/**
 * Splits a parsed MCP POST body for the retired stage: tool calls are answered
 * here with the retirement message; everything else (initialize, tools/list,
 * notifications) still goes to the agent.
 */
export function answerRetiredToolCalls(
	body: unknown,
	baseUrl: string,
): { answered: unknown[]; rest: unknown[]; batch: boolean } {
	const batch = Array.isArray(body)
	const messages = batch ? (body as unknown[]) : [body]
	const answered: unknown[] = []
	const rest: unknown[] = []
	for (const message of messages) {
		if (!isToolCall(message)) {
			rest.push(message)
			continue
		}
		const args = isObject(message.params?.arguments)
			? message.params.arguments
			: undefined
		answered.push({
			jsonrpc: '2.0',
			id: message.id,
			result: {
				content: [
					{
						type: 'text',
						text: RETIREMENT_COPY.retired(siteUrlForCall(baseUrl, args)),
					},
				],
				isError: true,
			},
		})
	}
	return { answered, rest, batch }
}

/**
 * Adds the notice to every tool result in an MCP response body. Only results
 * that carry a `content` array are tool results; others pass unchanged.
 */
export function withNoticeOnToolResults(body: unknown): unknown {
	const add = (message: unknown) => {
		if (!isObject(message) || !isObject(message.result)) return message
		const content = message.result.content
		if (!Array.isArray(content)) return message
		return {
			...message,
			result: {
				...message.result,
				content: [...content, { type: 'text', text: RETIREMENT_COPY.notice }],
			},
		}
	}
	return Array.isArray(body) ? body.map(add) : add(body)
}

/** Adds the notice to an `/api/learner/*` JSON body; non-objects pass unchanged. */
export function withNoticeOnHttpBody(body: unknown): unknown {
	return isObject(body) ? { ...body, notice: RETIREMENT_COPY.notice } : body
}
