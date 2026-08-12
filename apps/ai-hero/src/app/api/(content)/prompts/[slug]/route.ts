import { after, NextRequest, NextResponse } from 'next/server'
import { getDiscoveryBaseUrl } from '@/lib/agent-discovery'
import { extractGA4ClientId, sendGA4Event } from '@/lib/ga4-measurement'
import { isPromptPubliclyViewable, type Prompt } from '@/lib/prompts'
import { getPrompt, getPromptProductIds } from '@/lib/prompts-query'
import {
	resolvePromptSubscriberContext,
	type PromptSubscriberContext,
} from '@/lib/prompt-subscriber-context'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
}

const DEFAULT_AGENT_INSTRUCTIONS = [
	'Read the event facts and action URLs before changing a calendar.',
	'Check for an existing event with the same title and start time. Do not create a duplicate.',
	'Use actions.agentCalendarUrl to add the event when direct calendar access is unavailable.',
	'Keep the tracked watch URL in the calendar event description.',
	'Confirm the saved title, start time, end time, timezone, and watch URL to the user.',
]

const FULL_AUTH_COMMAND =
	'curl -fsSL https://github.com/badass-courses/coursebuilder-cli/releases/latest/download/install.sh | sh && "$HOME/.local/bin/cb" auth login --app ai-hero'

type PromptAgentDocument = ReturnType<typeof buildPromptAgentDocument>

export function buildPromptAgentDocument({
	prompt,
	productIds,
	authMethod,
	subscriberContext,
}: {
	prompt: Prompt
	productIds: string[]
	authMethod: 'device-token' | 'personal-access-token' | 'anonymous'
	subscriberContext: PromptSubscriberContext
}) {
	const baseUrl = getDiscoveryBaseUrl()
	const slug = prompt.fields.slug
	const event = prompt.fields.event

	return {
		schema: 'aihero.agent-prompt.v1',
		title: prompt.fields.title,
		slug,
		visibility: prompt.fields.visibility,
		productIds,
		prompt: prompt.fields.body?.trim() ?? '',
		description: prompt.fields.description ?? null,
		agentInstructions:
			prompt.fields.agentInstructions?.length
				? prompt.fields.agentInstructions
				: DEFAULT_AGENT_INSTRUCTIONS,
		event: event
			? {
					title: event.title,
					description: event.description ?? null,
					startsAt: event.startsAt,
					endsAt: event.endsAt,
					timezone: event.timezone,
				}
			: null,
		actions: event
			? {
					agentCalendarUrl: event.agentCalendarUrl,
					humanCalendarUrl: event.humanCalendarUrl,
					watchUrl: event.watchUrl,
				}
			: null,
		viewer: {
			authenticated: authMethod !== 'anonymous',
			authMethod,
			kitSubscriber: subscriberContext,
			note:
				authMethod === 'anonymous'
					? 'Kit subscriber context is a read-only identity hint, not account authorization.'
					: 'Account authorization was accepted. No private identity fields are returned.',
		},
		authorization: {
			lightweight: {
				provider: 'kit',
				status: subscriberContext.status,
				grants: ['published_prompt:read', 'launch_event:read'],
				doesNotGrant: [
					'account_profile:read',
					'purchases:read',
					'calendar:write',
				],
			},
			full: {
				method: 'OAuth 2.0 device flow',
				command: FULL_AUTH_COMMAND,
				instructions:
					'Run this single terminal command. Complete the browser verification when the CLI opens it. The CLI stores the token locally and never puts it in a URL.',
			},
		},
		links: {
			human: `${baseUrl}/prompts/${slug}`,
			json: `${baseUrl}/api/prompts/${slug}`,
		},
		nextActions: event
			? [
					{
						command: `Open ${event.agentCalendarUrl}`,
						description:
							'Add the event through the tracked agent calendar action.',
					},
					{
						command: `Open ${event.watchUrl}`,
						description: 'Open the livestream reminder page.',
					},
				]
			: [],
	}
}

function toMarkdown(document: PromptAgentDocument) {
	const eventLines = document.event
		? [
				`- Title: ${document.event.title}`,
				`- Starts: ${document.event.startsAt}`,
				`- Ends: ${document.event.endsAt}`,
				`- Timezone: ${document.event.timezone}`,
			]
		: ['- No event is attached.']
	const actionLines = document.actions
		? [
				`- Agent calendar: ${document.actions.agentCalendarUrl}`,
				`- Human calendar: ${document.actions.humanCalendarUrl}`,
				`- Watch: ${document.actions.watchUrl}`,
			]
		: ['- No actions are attached.']

	return [
		`# ${document.title}`,
		'',
		'## AGENT INSTRUCTIONS',
		'',
		...document.agentInstructions.map((instruction, index) =>
			`${index + 1}. ${instruction}`,
		),
		'',
		'## PROMPT',
		'',
		document.prompt,
		'',
		'## EVENT',
		'',
		...eventLines,
		'',
		'## ACTIONS',
		'',
		...actionLines,
		'',
		'## AUTHORIZATION',
		'',
		`- Kit reader context: ${document.authorization.lightweight.status}`,
		'- Kit reader context grants only published prompt and launch event reads.',
		'- For proper account authorization, run this one terminal command:',
		'',
		'```sh',
		document.authorization.full.command,
		'```',
		'',
	].join('\n')
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

const getPromptHandler = async (
	request: NextRequest,
	context: { params: Promise<{ slug: string }> },
) => {
	const { slug } = await context.params
	const prompt = await getPrompt(slug)

	if (!prompt) {
		return NextResponse.json(
			{ error: 'Prompt not found' },
			{ status: 404, headers: corsHeaders },
		)
	}

	const auth = await getUserAbilityForRequest(request)
	const canReadPrivate =
		auth.authMethod !== 'anonymous' && auth.ability.can('read', 'Content')

	if (!isPromptPubliclyViewable(prompt) && !canReadPrivate) {
		return NextResponse.json(
			{ error: 'Prompt not found' },
			{ status: 404, headers: corsHeaders },
		)
	}

	const subscriberId =
		request.nextUrl.searchParams.get('ck_subscriber_id') ??
		request.cookies.get('ck_subscriber_id')?.value
	const shKit = request.nextUrl.searchParams.get('sh_kit')
	const [productIds, subscriberContext] = await Promise.all([
		getPromptProductIds(prompt.id),
		resolvePromptSubscriberContext({ subscriberId, shKit }),
	])
	const document = buildPromptAgentDocument({
		prompt,
		productIds,
		authMethod: auth.authMethod,
		subscriberContext,
	})
	const sourceCandidate =
		request.nextUrl.searchParams.get('source') ??
		request.cookies.get('sl_ref')?.value
	const sourceShortlink =
		sourceCandidate && /^[a-z0-9_-]{1,80}$/i.test(sourceCandidate)
			? sourceCandidate
			: undefined
	const pageLocation = `${getDiscoveryBaseUrl()}/api/prompts/${prompt.fields.slug}`

	after(async () => {
		const receipt = await sendGA4Event({
			client_id: extractGA4ClientId(request.cookies.get('_ga')?.value),
			user_id: auth.user?.id,
			events: [
				{
					name: 'agent_prompt_context_read',
					params: {
						page_location: pageLocation,
						prompt_slug: prompt.fields.slug,
						product_id: productIds.at(0),
						source_shortlink: sourceShortlink,
						actor_intent: 'agent_context_read',
						auth_method: auth.authMethod,
					},
				},
			],
		})

		void log.info('agent-prompt.context-read', {
			promptId: prompt.id,
			promptSlug: prompt.fields.slug,
			productIds,
			authMethod: auth.authMethod,
			analyticsStatus: receipt.status,
		})
	})

	const cacheControl =
		auth.authMethod === 'anonymous'
			? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
			: 'private, no-store'
	const headers = {
		...corsHeaders,
		'Cache-Control': cacheControl,
		Vary: 'Accept, Authorization',
	}
	const acceptsMarkdown = request.headers
		.get('Accept')
		?.includes('text/markdown')

	if (acceptsMarkdown) {
		return new NextResponse(toMarkdown(document), {
			headers: { ...headers, 'Content-Type': 'text/markdown; charset=utf-8' },
		})
	}

	return NextResponse.json(document, { headers })
}

export const GET = withSkill(getPromptHandler)
