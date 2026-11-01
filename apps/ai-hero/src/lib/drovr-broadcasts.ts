/**
 * AI Hero's broadcast producers go through drovr's BroadcastActor and never
 * touch Kit ("Fully off Kit", Joel 2026-10-27). There is no Kit fallback and
 * no provider switch.
 *
 * The producer only prepares a drovr message file and checks it with
 * `validate_message_file`. Publishing a version is drovr's operator step.
 * A send starts only when an approver named in
 * `AI_HERO_BROADCAST_APPROVER_SLACK_IDS` clicks the Slack approval for an
 * exact published version; that click is the only caller of
 * `create_broadcast`, and nothing here schedules a send on its own.
 *
 * Pace, caps, tick and campaign are operator values in
 * `AI_HERO_SKILLS_DROVR_SEND_PLAN` (JSON). A missing or invalid plan fails
 * closed. The campaign id carries the AI Skills unsubscribe scope, so a
 * send without it could reach people who opted out of these emails.
 */

import { z } from 'zod'

export const AI_HERO_DROVR_TENANT_ID = 'org-aihero'
// drovr's registered sender for org-aihero (packages/content tenants).
export const AI_HERO_SKILLS_DROVR_SENDER = {
	address: 'matt@aihero.dev',
	name: 'Matt Pocock (AI Hero)',
} as const

export const DROVR_APPROVAL_ACTION_ID = 'ai_hero_skills_approve_drovr_send'

type Env = Record<string, string | undefined>

const SendPlanSchema = z.object({
	campaignId: z.string().min(1),
	campaignDisplayName: z.string().min(1),
	layoutId: z.string().min(1),
	perHour: z.number().int().positive(),
	hourly: z.number().int().positive(),
	daily: z.number().int().positive(),
	tickMs: z.number().int().positive(),
	shards: z.number().int().min(1).max(32).optional(),
})

export type DrovrSendPlan = z.infer<typeof SendPlanSchema>

export type DrovrSendPlanRead =
	| { ok: true; plan: DrovrSendPlan }
	| { ok: false; reason: string }

export function drovrSendPlan(env: Env = process.env): DrovrSendPlanRead {
	const raw = env.AI_HERO_SKILLS_DROVR_SEND_PLAN?.trim()
	if (!raw)
		return { ok: false, reason: 'AI_HERO_SKILLS_DROVR_SEND_PLAN is not set' }
	let json: unknown
	try {
		json = JSON.parse(raw)
	} catch {
		return { ok: false, reason: 'AI_HERO_SKILLS_DROVR_SEND_PLAN is not JSON' }
	}
	const parsed = SendPlanSchema.safeParse(json)
	if (!parsed.success) {
		return {
			ok: false,
			reason: `AI_HERO_SKILLS_DROVR_SEND_PLAN is invalid: ${parsed.error.issues
				.map((issue) => issue.path.join('.') || issue.message)
				.join(', ')}`,
		}
	}
	return { ok: true, plan: parsed.data }
}

/** Slack user ids allowed to approve a real send; none means nobody. */
export function broadcastApprovers(
	env: Env = process.env,
): ReadonlySet<string> {
	return new Set(
		(env.AI_HERO_BROADCAST_APPROVER_SLACK_IDS ?? '')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean),
	)
}

// The drovr capability shapes this client sends and reads
// (drovr packages/contracts/src/broadcasts.ts and contract.ts).

export type DrovrBroadcastSelector = { _tag: 'Tenant' }

export type DrovrBroadcastDraft = {
	at: number
	broadcastId: string
	campaign: { id: string; displayName: string }
	caps: { hourly: number; daily: number }
	messageId: string
	pace: { kind: 'rate'; perHour: number }
	tenantId: string
	tickMs: number
	version: string
}

export type DrovrCreateBroadcastInput = {
	draft: DrovrBroadcastDraft
	selector: DrovrBroadcastSelector
	startAt: 'now'
}

export type DrovrCreateShardedBroadcastInput = DrovrCreateBroadcastInput & {
	shards: { count: number }
}

export type DrovrBroadcastAddress = { broadcastId: string; tenantId: string }

export type DrovrBroadcastReport = {
	/** Only sharded answers name the broadcast; a single one is addressed. */
	broadcastId: string | null
	phase: string | null
	captured: number | null
	sent: number | null
	nextMoves: string[]
}

export type DrovrNewMessage = { id: string; path: string }

export type DrovrMessageValidation = {
	messageId: string
	path: string
	status: 'valid' | 'cataloged' | 'refused'
	reasons: string[]
}

export type DrovrRefusal = {
	ok: false
	status: number | 'timeout' | 'network'
	problemType?: string
	title?: string
	detail?: string
}

export type DrovrCall<T> = { ok: true; value: T } | DrovrRefusal

export interface DrovrBroadcastClient {
	newMessage(input: {
		kind: 'broadcast'
		slug: string
	}): Promise<DrovrCall<DrovrNewMessage>>
	validateMessageFile(input: {
		path: string
		text: string
	}): Promise<DrovrCall<DrovrMessageValidation>>
	createBroadcast(
		input: DrovrCreateBroadcastInput,
	): Promise<DrovrCall<DrovrBroadcastReport>>
	createShardedBroadcast(
		input: DrovrCreateShardedBroadcastInput,
	): Promise<DrovrCall<DrovrBroadcastReport>>
	broadcastStatus(
		address: DrovrBroadcastAddress,
	): Promise<DrovrCall<DrovrBroadcastReport>>
	shardedBroadcastStatus(
		address: DrovrBroadcastAddress,
	): Promise<DrovrCall<DrovrBroadcastReport>>
}

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const numberOrNull = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null

const stringOrNull = (value: unknown): string | null =>
	typeof value === 'string' ? value : null

const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: []

const BROADCAST_PHASES = new Set([
	'capturing',
	'capture-paused',
	'captured',
	'freezing',
	'scheduled',
	'sending',
	'paused',
	'done',
	'cancelled',
])

/**
 * Reads `broadcast_status` and `sharded_broadcast_status` answers alike.
 * Null unless the answer proves a broadcast: drovr's required capture
 * fields, a known phase if any, and a broadcast id on a sharded answer.
 */
export function readBroadcastReport(
	body: unknown,
): DrovrBroadcastReport | null {
	const output = record(body)
	const sharded = output.sharded !== undefined
	const status = record(sharded ? output.sharded : output.broadcast)
	const broadcastId = stringOrNull(status.broadcastId)
	const phase = stringOrNull(status.phase)
	if (
		typeof status.captureComplete !== 'boolean' ||
		numberOrNull(status.captured) === null ||
		(status.phase !== undefined && !BROADCAST_PHASES.has(phase ?? '')) ||
		(sharded && !broadcastId)
	) {
		return null
	}
	return {
		broadcastId,
		phase,
		captured: numberOrNull(status.captured),
		sent: numberOrNull(record(status.stats).sent),
		nextMoves: strings(output.nextMoves),
	}
}

function readNewMessage(body: unknown): DrovrNewMessage | null {
	const output = record(body)
	const id = stringOrNull(output.id)
	const path = stringOrNull(output.path)
	return id && path ? { id, path } : null
}

const VALIDATION_STATUSES = new Set(['valid', 'cataloged', 'refused'])

function readValidation(body: unknown): DrovrMessageValidation | null {
	const output = record(body)
	const status = stringOrNull(output.status)
	const messageId = stringOrNull(output.messageId)
	const path = stringOrNull(output.path)
	if (!status || !VALIDATION_STATUSES.has(status) || !messageId || !path) {
		return null
	}
	return {
		messageId,
		path,
		status: status as DrovrMessageValidation['status'],
		reasons: strings(output.reasons),
	}
}

export type DrovrBroadcastClientConfig = {
	baseUrl: string | undefined
	apiKey: string | undefined
}

/**
 * The HTTP projection of drovr's capabilities, with the tenant key. A
 * refusal keeps drovr's problem type and detail; an unreadable answer is a
 * refusal, never a guessed success.
 */
export function createDrovrBroadcastClient(args: {
	config: DrovrBroadcastClientConfig
	fetcher?: typeof fetch
	timeoutMs?: number
}): DrovrBroadcastClient | null {
	const { baseUrl, apiKey } = args.config
	if (!baseUrl || !apiKey) return null
	const root = baseUrl.replace(/\/+$/, '')

	async function call<T>(
		path: string,
		input: unknown,
		read: (body: unknown) => T | null,
	): Promise<DrovrCall<T>> {
		const controller = new AbortController()
		const timeout = setTimeout(
			() => controller.abort(),
			args.timeoutMs ?? 15_000,
		)
		try {
			const response = await (args.fetcher ?? fetch)(`${root}${path}`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(input),
				signal: controller.signal,
			})
			const text = await response.text()
			let body: unknown = null
			try {
				body = text ? JSON.parse(text) : null
			} catch {
				body = null
			}
			if (!response.ok) {
				const problem = record(body)
				return {
					ok: false,
					status: response.status,
					problemType: stringOrNull(problem.type) ?? undefined,
					title: stringOrNull(problem.title) ?? undefined,
					detail: stringOrNull(problem.detail) ?? undefined,
				}
			}
			const value = read(body)
			if (value === null) {
				return {
					ok: false,
					status: response.status,
					detail: `drovr answered ${path} with an unknown shape`,
				}
			}
			return { ok: true, value }
		} catch (error) {
			return {
				ok: false,
				status: controller.signal.aborted ? 'timeout' : 'network',
				detail: error instanceof Error ? error.message : String(error),
			}
		} finally {
			clearTimeout(timeout)
		}
	}

	return {
		newMessage: (input) => call('/content/messages/new', input, readNewMessage),
		validateMessageFile: (input) =>
			call('/content/messages/validate', input, readValidation),
		createBroadcast: (input) =>
			call('/create_broadcast', input, readBroadcastReport),
		createShardedBroadcast: (input) =>
			call('/create_sharded_broadcast', input, readBroadcastReport),
		broadcastStatus: (address) =>
			call('/broadcast_status', address, readBroadcastReport),
		shardedBroadcastStatus: (address) =>
			call('/sharded_broadcast_status', address, readBroadcastReport),
	}
}

export function drovrBroadcastClientFromEnv(
	env: Env = process.env,
): DrovrBroadcastClient | null {
	return createDrovrBroadcastClient({
		config: {
			baseUrl: env.DROVR_API_BASE_URL,
			apiKey: env.DROVR_API_KEY_ORG_AIHERO,
		},
	})
}

export function describeDrovrRefusal(refusal: DrovrRefusal): string {
	return [
		`drovr answered ${refusal.status}`,
		refusal.title,
		refusal.detail,
		refusal.problemType,
	]
		.filter(Boolean)
		.join(': ')
}

export const isAlreadyInitialized = (refusal: DrovrRefusal) =>
	refusal.status === 409 &&
	refusal.problemType === 'urn:drovr:problem:broadcast-already-initialized'

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

export function normalizeBroadcastHtml(content: string) {
	if (/<[a-z][\s\S]*>/i.test(content)) return content

	return content
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
		.join('\n')
}

/**
 * A drovr message file (`messages/<id>.md`): YAML frontmatter, then the
 * HTML body. JSON scalars are valid YAML, so every value is JSON-quoted.
 */
export function buildDrovrMessageFile(input: {
	messageId: string
	subject: string
	previewText?: string | null
	content: string
	layoutId: string
	provenance: string
}) {
	const subject = oneLine(input.subject)
	const preview = oneLine(input.previewText || '') || subject
	const frontmatter: Array<[string, unknown]> = [
		['id', input.messageId],
		['kind', 'broadcast'],
		['subject', subject],
		['preview', preview],
		['layout', input.layoutId],
		['from', AI_HERO_SKILLS_DROVR_SENDER],
		['format', 'html'],
		['provenance', oneLine(input.provenance)],
	]
	const text = `---\n${frontmatter
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join('\n')}\n---\n${normalizeBroadcastHtml(input.content)}\n`
	return { path: `messages/${input.messageId}.md`, text }
}

export type DrovrPreparedMessage =
	| {
			status: 'prepared'
			messageId: string
			path: string
			text: string
			validation: DrovrMessageValidation
	  }
	| { status: 'skipped'; reason: string }

/**
 * The producer half: mint (or reuse) a drovr message id, write the file and
 * check it as a push would. Nothing is published, created or sent; a
 * transport failure throws so the caller's retry runs again.
 */
export async function prepareDrovrSkillsMessage(args: {
	existingMessageId?: string | null
	slug: string
	resourceId: string
	subject: string
	previewText?: string | null
	content: string
	env?: Env
	client: DrovrBroadcastClient | null
}): Promise<DrovrPreparedMessage> {
	const plan = drovrSendPlan(args.env ?? process.env)
	if (!plan.ok) return { status: 'skipped', reason: plan.reason }
	if (!args.client)
		return { status: 'skipped', reason: 'drovr is not configured' }

	let messageId = args.existingMessageId ?? null
	if (!messageId) {
		const minted = await args.client.newMessage({
			kind: 'broadcast',
			slug: `skill changelog ${args.slug}`,
		})
		if (!minted.ok) throw new Error(describeDrovrRefusal(minted))
		messageId = minted.value.id
	}

	const file = buildDrovrMessageFile({
		messageId,
		subject: args.subject,
		previewText: args.previewText,
		content: args.content,
		layoutId: plan.plan.layoutId,
		provenance: `ai-hero:skill-changelog/${args.resourceId}`,
	})
	const validation = await args.client.validateMessageFile(file)
	if (!validation.ok) throw new Error(describeDrovrRefusal(validation))

	return {
		status: 'prepared',
		messageId,
		path: file.path,
		text: file.text,
		validation: validation.value,
	}
}

/** One send per published version: a second approval meets the first. */
export const drovrBroadcastIdFor = (messageId: string, version: string) =>
	`${messageId}@${version}`

export const DrovrApprovalValueSchema = z.object({
	messageId: z.string().min(1),
	version: z.string().min(1),
	subject: z.string().min(1),
	shortlink: z.string().url(),
})

export type DrovrApprovalValue = z.infer<typeof DrovrApprovalValueSchema>

/**
 * The Slack approval for one published drovr version. Slack asks the
 * approver to confirm before the click reaches the approval route.
 */
export function drovrApprovalBlocks(value: DrovrApprovalValue) {
	return [
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `*AI Hero Skills broadcast through drovr*\n${value.subject}\nmessage \`${value.messageId}\` version \`${value.version}\`\n${value.shortlink}`,
			},
		},
		{
			type: 'actions',
			elements: [
				{
					type: 'button',
					action_id: DROVR_APPROVAL_ACTION_ID,
					style: 'danger',
					text: { type: 'plain_text', text: 'Approve and send', emoji: true },
					value: JSON.stringify(value),
					confirm: {
						title: { type: 'plain_text', text: 'Send to the list?' },
						text: {
							type: 'mrkdwn',
							text: 'drovr sends this version to every consented AI Hero contact outside the AI Skills unsubscribe scope. It cannot be unsent.',
						},
						confirm: { type: 'plain_text', text: 'Send' },
						deny: { type: 'plain_text', text: 'Cancel' },
					},
				},
			],
		},
	]
}

export type DrovrApprovalOutcome =
	| {
			status: 'created' | 'already_created'
			broadcastId: string
			report: DrovrBroadcastReport | null
	  }
	| { status: 'refused'; reason: string }

/**
 * Turn one explicit approval into one drovr broadcast. The caller has
 * already checked the Slack signature, channel and approver; this checks
 * the provider and plan again and refuses rather than guessing.
 */
export async function approveDrovrBroadcast(args: {
	value: DrovrApprovalValue
	approverSlackId: string
	env?: Env
	client: DrovrBroadcastClient | null
	now?: () => number
}): Promise<DrovrApprovalOutcome> {
	const env = args.env ?? process.env
	if (!broadcastApprovers(env).has(args.approverSlackId)) {
		return {
			status: 'refused',
			reason: 'this Slack user is not an approver for real sends',
		}
	}
	const plan = drovrSendPlan(env)
	if (!plan.ok) return { status: 'refused', reason: plan.reason }
	if (!args.client) {
		return { status: 'refused', reason: 'drovr is not configured' }
	}

	const broadcastId = drovrBroadcastIdFor(
		args.value.messageId,
		args.value.version,
	)
	const input: DrovrCreateBroadcastInput = {
		draft: {
			at: (args.now ?? Date.now)(),
			broadcastId,
			campaign: {
				id: plan.plan.campaignId,
				displayName: plan.plan.campaignDisplayName,
			},
			caps: { hourly: plan.plan.hourly, daily: plan.plan.daily },
			messageId: args.value.messageId,
			pace: { kind: 'rate', perHour: plan.plan.perHour },
			tenantId: AI_HERO_DROVR_TENANT_ID,
			tickMs: plan.plan.tickMs,
			version: args.value.version,
		},
		selector: { _tag: 'Tenant' },
		startAt: 'now',
	}
	const shards = plan.plan.shards ?? 1
	const created =
		shards > 1
			? await args.client.createShardedBroadcast({
					...input,
					shards: { count: shards },
				})
			: await args.client.createBroadcast(input)

	if (created.ok) {
		const answered = created.value.broadcastId
		if (answered !== null && answered !== broadcastId) {
			return {
				status: 'refused',
				reason: `drovr answered for ${answered}, not ${broadcastId}; the send is unconfirmed`,
			}
		}
		return { status: 'created', broadcastId, report: created.value }
	}
	if (created.status === 200) {
		// drovr accepted the call but its answer proves nothing: say so, never
		// announce a send.
		return {
			status: 'refused',
			reason: `drovr gave an unreadable answer; the send is unconfirmed, check broadcast_status for ${broadcastId}`,
		}
	}
	if (isAlreadyInitialized(created)) {
		const address = { broadcastId, tenantId: AI_HERO_DROVR_TENANT_ID }
		const status =
			shards > 1
				? await args.client.shardedBroadcastStatus(address)
				: await args.client.broadcastStatus(address)
		return {
			status: 'already_created',
			broadcastId,
			report: status.ok ? status.value : null,
		}
	}
	return { status: 'refused', reason: describeDrovrRefusal(created) }
}
