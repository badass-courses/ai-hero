'use client'

import { useMemo, useReducer } from 'react'
import { CheckIcon, ClipboardIcon, Loader2Icon } from 'lucide-react'

type AgentSurface = {
	name: string
	description: string
	category: string
}

type AgentPromptInput = {
	appName: string
	endpoint: string
	token: string
	ttlLabel: string
	expiresAt: string
	surfaces: AgentSurface[]
}

export const AGENT_PROMPT_TIMEOUT_MS = 5_000

export function isAgentPromptTokenActive(
	expiresAt: unknown,
	now = Date.now(),
) {
	if (typeof expiresAt !== 'string' || expiresAt.length === 0) return false
	const timestamp = Date.parse(expiresAt)
	return Number.isFinite(timestamp) && timestamp > now
}

export type AgentPromptState =
	| { status: 'idle'; prompt: null; expiresAt: null; error: null }
	| { status: 'generating'; prompt: null; expiresAt: null; error: null }
	| { status: 'copied'; prompt: string; expiresAt: string; error: null }
	| {
			status: 'manual-copy'
			prompt: string
			expiresAt: string
			error: string
	  }
	| { status: 'failed'; prompt: null; expiresAt: null; error: string }

type AgentPromptEvent =
	| { type: 'generate-start' }
	| { type: 'copied'; prompt: string; expiresAt: string }
	| { type: 'manual-copy'; prompt: string; expiresAt: string; error: string }
	| { type: 'failed'; error: string }
	| { type: 'reset' }

const INITIAL_AGENT_PROMPT_STATE: AgentPromptState = {
	status: 'idle',
	prompt: null,
	expiresAt: null,
	error: null,
}

export function agentPromptReducer(
	state: AgentPromptState,
	event: AgentPromptEvent,
): AgentPromptState {
	switch (event.type) {
		case 'generate-start':
			return {
				status: 'generating',
				prompt: null,
				expiresAt: null,
				error: null,
			}
		case 'copied':
			return {
				status: 'copied',
				prompt: event.prompt,
				expiresAt: event.expiresAt,
				error: null,
			}
		case 'manual-copy':
			return {
				status: 'manual-copy',
				prompt: event.prompt,
				expiresAt: event.expiresAt,
				error: event.error,
			}
		case 'failed':
			return {
				status: 'failed',
				prompt: null,
				expiresAt: null,
				error: event.error,
			}
		case 'reset':
			return INITIAL_AGENT_PROMPT_STATE
	}
}

export function buildAgentPrompt({
	appName,
	endpoint,
	token,
	ttlLabel,
	expiresAt,
	surfaces,
}: AgentPromptInput) {
	const categories = new Map<string, number>()
	for (const surface of surfaces) {
		categories.set(
			surface.category,
			(categories.get(surface.category) ?? 0) + 1,
		)
	}
	const categoryLine = [...categories.entries()]
		.map(([category, count]) => `${category} (${count})`)
		.join(', ')

	const picks: Array<{ name: string; description: string }> = [
		{ name: '', description: 'surface catalog' },
	]
	const seen = new Set<string>()
	const preferred = [
		'summary',
		'attribution/coverage',
		'traffic',
		'youtube/videos',
		'surveys',
		'correlation/traffic-revenue',
		'correlation/youtube-revenue',
		'attribution/email-campaigns',
	]
	for (const name of preferred) {
		const surface = surfaces.find((candidate) => candidate.name === name)
		if (surface && !seen.has(surface.category)) {
			seen.add(surface.category)
			picks.push({ name: surface.name, description: surface.description })
		}
	}
	for (const surface of surfaces) {
		if (!seen.has(surface.category)) {
			seen.add(surface.category)
			picks.push({ name: surface.name, description: surface.description })
		}
	}

	const exampleLines = picks
		.map((pick) =>
			pick.name
				? `GET ${endpoint}?surface=${pick.name}&range=30d  → ${pick.description}`
				: `GET ${endpoint}  → ${pick.description}`,
		)
		.join('\n')

	const ytNote = surfaces.some((surface) => surface.category === 'youtube')
		? `\nImportant:\n- YouTube surfaces are useful for correlation and content analysis, not live dashboard ops\n- YouTube Analytics data lags by about 48 hours, so call out the delay when interpreting fresh periods\n`
		: ''

	return `# ${appName} Analytics API
Base: ${endpoint}
Auth: Bearer ${token}
Token expires: ${new Date(expiresAt).toLocaleString()} (${ttlLabel})

${exampleLines}
${ytNote}
Example:
curl -H "Authorization: Bearer ${token}" "${endpoint}?surface=summary&range=30d"

Categories: ${categoryLine}
Every response has contextual next_actions. Errors have codes + fix hints.`
}

type AnalyticsFetch = typeof fetch

function timeoutError(label: string) {
	const error = new Error(`${label} timed out.`)
	error.name = 'AbortError'
	return error
}

function withDeadline<T>(
	operation: () => Promise<T>,
	label: string,
	onTimeout?: () => void,
) {
	return new Promise<T>((resolve, reject) => {
		let settled = false
		const timeout = setTimeout(() => {
			if (settled) return
			settled = true
			onTimeout?.()
			reject(timeoutError(label))
		}, AGENT_PROMPT_TIMEOUT_MS)
		const finish = (callback: (value: T) => void, value: T) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			callback(value)
		}
		void Promise.resolve()
			.then(operation)
			.then(
				(value) => finish(resolve, value),
				(error) => {
					if (settled) return
					settled = true
					clearTimeout(timeout)
					reject(error)
				},
			)
	})
}

async function fetchJsonWithDeadline(
	fetchImpl: AnalyticsFetch,
	input: RequestInfo | URL,
	init: RequestInit,
	label: string,
) {
	const controller = new AbortController()
	return withDeadline(
		async () => {
			const response = await fetchImpl(input, {
				...init,
				signal: controller.signal,
			})
			const body = response.ok ? await response.json() : null
			return { response, body }
		},
		label,
		() => controller.abort(),
	)
}

export async function createAgentPrompt({
	appName,
	endpoint,
	fetchImpl = fetch,
}: {
	appName: string
	endpoint: string
	fetchImpl?: AnalyticsFetch
}) {
	const tokenPromise = fetchJsonWithDeadline(
		fetchImpl,
		'/api/analytics/token',
		{ method: 'POST', cache: 'no-store' },
		'Analytics token request',
	).then(({ response, body }) => {
		if (!response.ok) {
			throw new Error('Unable to generate analytics token.')
		}
		return body
	})
	const catalogPromise = fetchJsonWithDeadline(
		fetchImpl,
		'/api/analytics',
		{ cache: 'no-store' },
		'Analytics catalog request',
	)
		.then(({ response, body }) => (response.ok ? body : null))
		.catch(() => null)

	const [tokenBody, catalogBody] = await Promise.all([
		tokenPromise,
		catalogPromise,
	])

	const typedTokenBody = tokenBody as {
		token?: unknown
		ttlLabel?: unknown
		expiresAt?: unknown
	}
	if (
		typeof typedTokenBody.token !== 'string' ||
		typeof typedTokenBody.ttlLabel !== 'string' ||
		!isAgentPromptTokenActive(typedTokenBody.expiresAt)
	) {
		throw new Error('Analytics token response was incomplete or expired.')
	}

	let surfaces: AgentSurface[] = []
	const typedCatalogBody = catalogBody as { surfaces?: unknown } | null
	if (typedCatalogBody && Array.isArray(typedCatalogBody.surfaces)) {
		surfaces = typedCatalogBody.surfaces.filter(
			(surface: unknown): surface is AgentSurface =>
				Boolean(
					surface &&
					typeof surface === 'object' &&
					typeof (surface as AgentSurface).name === 'string' &&
					typeof (surface as AgentSurface).description === 'string' &&
					typeof (surface as AgentSurface).category === 'string',
				),
		)
	}

	const prompt = buildAgentPrompt({
		appName,
		endpoint,
		token: typedTokenBody.token,
		ttlLabel: typedTokenBody.ttlLabel,
		expiresAt: typedTokenBody.expiresAt as string,
		surfaces,
	})

	return { prompt, expiresAt: typedTokenBody.expiresAt as string }
}

type TextClipboard = {
	writeText: (text: string) => Promise<void>
}

export async function copyAgentPrompt(
	prompt: string,
	clipboard: TextClipboard = navigator.clipboard,
) {
	if (!clipboard?.writeText) {
		throw new Error('Clipboard access is unavailable.')
	}
	await clipboard.writeText(prompt)
}

type ClipboardItemValue = Blob | PromiseLike<Blob>
type ClipboardItemConstructor = new (
	items: Record<string, ClipboardItemValue>,
) => ClipboardItem

export type GestureClipboardWrite = {
	resolve: (prompt: string) => void
	reject: (error: unknown) => void
	promise: Promise<void>
}

export function startGestureClipboardWrite(): GestureClipboardWrite | null {
	try {
		if (
			typeof navigator === 'undefined' ||
			!navigator.clipboard?.write ||
			typeof globalThis.ClipboardItem !== 'function'
		) {
			return null
		}

		let resolvePayload!: (prompt: string) => void
		let rejectPayload!: (error: unknown) => void
		const payload = new Promise<Blob>((resolve, reject) => {
			resolvePayload = (prompt) =>
				resolve(new Blob([prompt], { type: 'text/plain' }))
			rejectPayload = reject
		})
		const ClipboardItemCtor = globalThis
			.ClipboardItem as unknown as ClipboardItemConstructor
		const promise = navigator.clipboard.write([
			new ClipboardItemCtor({ 'text/plain': payload }),
		])
		void promise.catch(() => undefined)

		return { resolve: resolvePayload, reject: rejectPayload, promise }
	} catch {
		return null
	}
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : 'Unknown analytics prompt error.'
}

export function AnalyticsAgentApiCard({
	appName = 'AI Hero',
}: {
	appName?: string
}) {
	const [state, dispatch] = useReducer(
		agentPromptReducer,
		INITIAL_AGENT_PROMPT_STATE,
	)
	const endpoint = useMemo(
		() =>
			typeof window === 'undefined'
				? 'https://www.aihero.dev/api/analytics'
				: `${window.location.origin}/api/analytics`,
		[],
	)

	const handleGenerateAndCopy = async () => {
		dispatch({ type: 'generate-start' })
		const gestureWrite = startGestureClipboardWrite()
		let prompt: string | null = null
		let expiresAt: string | null = null

		try {
			const result = await createAgentPrompt({ appName, endpoint })
			prompt = result.prompt
			expiresAt = result.expiresAt
			if (gestureWrite) {
				gestureWrite.resolve(prompt)
				await gestureWrite.promise
			} else {
				await copyAgentPrompt(prompt)
			}
			dispatch({ type: 'copied', prompt, expiresAt: expiresAt! })
		} catch (error) {
			gestureWrite?.reject(error)
			if (prompt) {
				dispatch({
					type: 'manual-copy',
					prompt,
					expiresAt: expiresAt!,
					error:
						'Clipboard access was denied. Select the prompt below and copy it manually.',
				})
			} else {
				dispatch({
					type: 'failed',
					error: errorMessage(error),
				})
			}
		}
	}

	const handleCopyExisting = async () => {
		if (!state.prompt) return
		if (!isAgentPromptTokenActive(state.expiresAt)) {
			await handleGenerateAndCopy()
			return
		}
		const prompt = state.prompt
		const gestureWrite = startGestureClipboardWrite()
		try {
			if (gestureWrite) {
				gestureWrite.resolve(prompt)
				await gestureWrite.promise
			} else {
				await copyAgentPrompt(prompt)
			}
			dispatch({
				type: 'copied',
				prompt,
				expiresAt: state.expiresAt,
			})
		} catch {
			gestureWrite?.reject(new Error('clipboard-denied'))
			dispatch({
				type: 'manual-copy',
				prompt,
				expiresAt: state.expiresAt,
				error:
					'Clipboard access was denied. Select the prompt below and copy it manually.',
			})
		}
	}

	const isGenerating = state.status === 'generating'
	const hasPrompt = Boolean(state.prompt)
	const action = hasPrompt ? handleCopyExisting : handleGenerateAndCopy

	return (
		<div className="border-border/30 flex flex-col gap-2 rounded-lg border px-3 py-2 sm:px-4 sm:py-2.5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2 text-xs">
					<span className="text-muted-foreground/60 shrink-0">⚡</span>
					<a
						href="/api/analytics"
						target="_blank"
						rel="noopener noreferrer"
						className="text-muted-foreground hover:text-foreground shrink-0 font-medium underline-offset-2 transition-colors hover:underline"
					>
						/api/analytics
					</a>
					<span className="text-muted-foreground/40 hidden sm:inline">·</span>
					<span className="text-muted-foreground/60 hidden sm:inline">
						HATEOAS catalog
					</span>
				</div>
				<button
					onClick={action}
					disabled={isGenerating}
					className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold transition-[transform,background-color,color,box-shadow] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] disabled:pointer-events-none ${
						state.status === 'copied'
							? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
							: isGenerating
								? 'bg-muted text-muted-foreground'
								: 'bg-primary/10 text-primary hover:bg-primary/20 shadow-sm'
					}`}
				>
					{isGenerating ? (
						<>
							<Loader2Icon className="h-3 w-3 animate-spin" />
							Generating token…
						</>
					) : state.status === 'copied' ? (
						<>
							<CheckIcon className="h-3 w-3" />
							Copied with token
						</>
					) : hasPrompt ? (
						'Copy prompt again'
					) : (
						<>
							<ClipboardIcon className="h-3 w-3" />
							Copy agent prompt
						</>
					)}
				</button>
			</div>
			{state.error && (
				<p role="alert" className="text-destructive text-xs">
					{state.error}
				</p>
			)}
			{state.prompt && state.status === 'manual-copy' && (
				<div className="flex flex-col gap-2">
					<label
						htmlFor="analytics-agent-prompt"
						className="text-muted-foreground text-xs"
					>
						Select the prompt and copy it manually:
					</label>
					<textarea
						id="analytics-agent-prompt"
						readOnly
						rows={8}
						value={state.prompt}
						onFocus={(event) => event.currentTarget.select()}
						className="bg-muted/30 text-foreground min-h-32 w-full resize-y rounded-md border border-input p-2 font-mono text-xs leading-relaxed focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					/>
				</div>
			)}
		</div>
	)
}
