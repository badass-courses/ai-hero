import { createHash, randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { getServerAuthSession } from '@/server/auth'
import { log, serializeError } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const SCOPES = [
	'https://www.googleapis.com/auth/yt-analytics.readonly',
	'https://www.googleapis.com/auth/youtube.force-ssl',
]

const REDIRECT_URI = 'https://www.aihero.dev/api/analytics/youtube-auth'
const STATE_COOKIE_NAME = 'youtube_auth_state'
const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10
const STATE_COOKIE_PATH = '/api/analytics/youtube-auth'

type StoredAuthVerification = {
	ok: boolean
	envConfigured: boolean
	missingEnvKeys: string[]
	refreshTokenFingerprint: string | null
	grantedScopes: string[]
	hasForceSsl: boolean
	hasAnalyticsReadonly: boolean
	channel: {
		ok: boolean
		title: string | null
		id: string | null
		error?: ReturnType<typeof serializeError>
	}
	liveBroadcastsProbe: {
		ok: boolean
		count: number | null
		error?: ReturnType<typeof serializeError>
	}
}

function getOAuth2Client() {
	const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID
	const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET

	if (!clientId || !clientSecret) {
		throw new Error('YOUTUBE_OAUTH_CLIENT_ID/SECRET required')
	}

	return new OAuth2Client(clientId, clientSecret, REDIRECT_URI)
}

function parseScopes(value: string | null | undefined): string[] {
	if (!value) return []
	return value
		.split(' ')
		.map((scope) => scope.trim())
		.filter(Boolean)
}

function fingerprintSecret(value: string | null | undefined): string | null {
	if (!value) return null
	return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function getStateCookieOptions() {
	return {
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		path: STATE_COOKIE_PATH,
		maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
	}
}

function buildHtmlPage(title: string, body: string) {
	return `<!doctype html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px">${title}${body}</body></html>`
}

async function emitAuthLog(
	level: 'info' | 'warn' | 'error',
	event: string,
	data: Record<string, unknown> = {},
) {
	await log[level](event, data)
	const serialized = JSON.stringify({ event, ...data })
	if (level === 'error') {
		console.error(`[youtube-auth] ${serialized}`)
	} else if (level === 'warn') {
		console.warn(`[youtube-auth] ${serialized}`)
	} else {
		console.info(`[youtube-auth] ${serialized}`)
	}
}

async function createHtmlResponse(
	title: string,
	body: string,
	clearStateCookie = false,
): Promise<NextResponse> {
	await log.flush()
	const response = new NextResponse(buildHtmlPage(title, body), {
		headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
	})
	if (clearStateCookie) {
		response.cookies.set(STATE_COOKIE_NAME, '', {
			...getStateCookieOptions(),
			maxAge: 0,
		})
	}
	return response
}

async function verifyStoredYouTubeAuth(): Promise<StoredAuthVerification> {
	const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID || null
	const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET || null
	const refreshToken = process.env.YOUTUBE_ANALYTICS_REFRESH_TOKEN || null
	const missingEnvKeys = [
		!clientId ? 'YOUTUBE_OAUTH_CLIENT_ID' : null,
		!clientSecret ? 'YOUTUBE_OAUTH_CLIENT_SECRET' : null,
		!refreshToken ? 'YOUTUBE_ANALYTICS_REFRESH_TOKEN' : null,
	].filter(Boolean) as string[]

	const baseResult: StoredAuthVerification = {
		ok: false,
		envConfigured: missingEnvKeys.length === 0,
		missingEnvKeys,
		refreshTokenFingerprint: fingerprintSecret(refreshToken),
		grantedScopes: [],
		hasForceSsl: false,
		hasAnalyticsReadonly: false,
		channel: {
			ok: false,
			title: null,
			id: null,
		},
		liveBroadcastsProbe: {
			ok: false,
			count: null,
		},
	}

	if (missingEnvKeys.length > 0 || !refreshToken) {
		return baseResult
	}

	const oauth2Client = getOAuth2Client()
	const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId!,
			client_secret: clientSecret!,
			refresh_token: refreshToken,
			grant_type: 'refresh_token',
		}),
	})

	if (!tokenResponse.ok) {
		const body = await tokenResponse.text()
		return {
			...baseResult,
			channel: {
				ok: false,
				title: null,
				id: null,
				error: serializeError(
					new Error(`Token refresh failed: ${tokenResponse.status} ${body}`),
				),
			},
		}
	}

	const tokenJson = (await tokenResponse.json()) as {
		access_token?: string
		scope?: string
	}
	const grantedScopes = parseScopes(tokenJson.scope)
	oauth2Client.setCredentials({ refresh_token: refreshToken })
	const youtube = google.youtube({ version: 'v3', auth: oauth2Client })

	const result: StoredAuthVerification = {
		...baseResult,
		ok: true,
		grantedScopes,
		hasForceSsl: grantedScopes.includes(
			'https://www.googleapis.com/auth/youtube.force-ssl',
		),
		hasAnalyticsReadonly: grantedScopes.includes(
			'https://www.googleapis.com/auth/yt-analytics.readonly',
		),
	}

	try {
		const channels = await youtube.channels.list({
			mine: true,
			part: ['id', 'snippet'],
		})
		const firstChannel = channels.data.items?.[0]
		result.channel = {
			ok: Boolean(firstChannel),
			title: firstChannel?.snippet?.title || null,
			id: firstChannel?.id || null,
		}
	} catch (error) {
		result.channel = {
			ok: false,
			title: null,
			id: null,
			error: serializeError(error),
		}
	}

	try {
		const liveBroadcasts = await youtube.liveBroadcasts.list({
			mine: true,
			maxResults: 5,
			part: ['id', 'snippet', 'status'],
		})
		result.liveBroadcastsProbe = {
			ok: true,
			count: liveBroadcasts.data.items?.length ?? 0,
		}
	} catch (error) {
		result.liveBroadcastsProbe = {
			ok: false,
			count: null,
			error: serializeError(error),
		}
	}

	return result
}

/**
 * GET /api/analytics/youtube-auth
 *
 * Modes:
 * 1. No ?code, requires admin auth, redirects to Google consent screen
 * 2. With ?code, exchanges for tokens after Google redirects back here
 * 3. ?verify=1, requires admin auth, verifies the stored refresh token and scopes
 */
export const GET = withSkill(async (request: NextRequest) => {
	const url = new URL(request.url)
	const code = url.searchParams.get('code')
	const error = url.searchParams.get('error')
	const verify = url.searchParams.get('verify') === '1'
	const stateFromQuery = url.searchParams.get('state')
	const stateFromCookie = request.cookies.get(STATE_COOKIE_NAME)?.value || null
	const requestId = stateFromQuery || stateFromCookie || randomUUID()
	const requestedScopes = SCOPES
	const callbackScopes = parseScopes(url.searchParams.get('scope'))

	if (verify) {
		const { ability } = await getServerAuthSession()
		if (ability.cannot('manage', 'all')) {
			await emitAuthLog('warn', 'youtube-auth.verify.unauthorized', {
				requestId,
			})
			return NextResponse.json(
				{ error: 'Unauthorized, admin only' },
				{ status: 401 },
			)
		}

		const verification = await verifyStoredYouTubeAuth()
		await emitAuthLog('info', 'youtube-auth.verify.completed', {
			requestId,
			ok: verification.ok,
			envConfigured: verification.envConfigured,
			missingEnvKeys: verification.missingEnvKeys,
			refreshTokenFingerprint: verification.refreshTokenFingerprint,
			grantedScopes: verification.grantedScopes,
			hasForceSsl: verification.hasForceSsl,
			hasAnalyticsReadonly: verification.hasAnalyticsReadonly,
			channelOk: verification.channel.ok,
			channelTitle: verification.channel.title,
			liveBroadcastsProbeOk: verification.liveBroadcastsProbe.ok,
			liveBroadcastsCount: verification.liveBroadcastsProbe.count,
			liveBroadcastsProbeError:
				verification.liveBroadcastsProbe.error?.message || null,
		})
		await log.flush()
		return NextResponse.json(verification, {
			status: verification.ok ? 200 : 500,
			headers: { 'Cache-Control': 'no-store' },
		})
	}

	if (error) {
		await emitAuthLog('warn', 'youtube-auth.callback.error', {
			requestId,
			error,
			callbackScopes,
			statePresent: Boolean(stateFromQuery),
			stateCookiePresent: Boolean(stateFromCookie),
		})
		return createHtmlResponse(
			'<h1>❌ Authorization denied</h1>',
			`<p>Error: ${error}</p><p>You can close this tab.</p>`,
			true,
		)
	}

	if (code) {
		if (
			!stateFromQuery ||
			!stateFromCookie ||
			stateFromQuery !== stateFromCookie
		) {
			await emitAuthLog('warn', 'youtube-auth.callback.state-mismatch', {
				requestId,
				statePresent: Boolean(stateFromQuery),
				stateCookiePresent: Boolean(stateFromCookie),
				stateMatches: stateFromQuery === stateFromCookie,
				callbackScopes,
			})
			return createHtmlResponse(
				'<h1>⚠️ Authorization could not be verified</h1>',
				'<p>The OAuth state check failed. Please start the flow again from AI Hero.</p>',
				true,
			)
		}

		await emitAuthLog('info', 'youtube-auth.callback.received', {
			requestId,
			callbackScopes,
			requestedScopes,
		})

		try {
			const oauth2Client = getOAuth2Client()
			const { tokens } = await oauth2Client.getToken(code)
			const grantedScopesFromToken = parseScopes(tokens.scope)
			const refreshTokenFingerprint = fingerprintSecret(tokens.refresh_token)

			await emitAuthLog('info', 'youtube-auth.token-exchanged', {
				requestId,
				callbackScopes,
				grantedScopesFromToken,
				accessTokenReturned: Boolean(tokens.access_token),
				refreshTokenReturned: Boolean(tokens.refresh_token),
				refreshTokenFingerprint,
			})

			if (!tokens.refresh_token) {
				await emitAuthLog('warn', 'youtube-auth.refresh-token-missing', {
					requestId,
					callbackScopes,
					grantedScopesFromToken,
					fix: 'Revoke the existing Google app grant, then retry so Google returns a fresh refresh token.',
				})
				return createHtmlResponse(
					'<h1>⚠️ No refresh token returned</h1>',
					'<p>Google did not return a refresh token. This usually means this app was already authorized earlier.</p><p>To fix this, go to <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, revoke the AI Hero app, then try again.</p>',
					true,
				)
			}

			const vercelToken = process.env.VERCEL_API_TOKEN
			const projectId = process.env.VERCEL_CB_PROJECT_ID
			const teamId = process.env.VERCEL_TEAM_ID
			let stored = false
			let storeResults: Array<{
				target: string
				ok: boolean
				status: number
				bodyPreview: string
			}> = []

			if (vercelToken && projectId) {
				try {
					const envParams = new URLSearchParams({ upsert: 'true' })
					if (teamId) {
						envParams.set('teamId', teamId)
					}
					const redeployParams = new URLSearchParams()
					if (teamId) {
						redeployParams.set('teamId', teamId)
					}
					const envQuery = `?${envParams.toString()}`
					const redeployQuery = redeployParams.toString()
						? `?${redeployParams.toString()}`
						: ''
					for (const target of ['production', 'preview', 'development']) {
						await emitAuthLog('info', 'youtube-auth.vercel-env-write.started', {
							requestId,
							target,
							refreshTokenFingerprint,
						})

						const resp = await fetch(
							`https://api.vercel.com/v10/projects/${projectId}/env${envQuery}`,
							{
								method: 'POST',
								headers: {
									Authorization: `Bearer ${vercelToken}`,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									key: 'YOUTUBE_ANALYTICS_REFRESH_TOKEN',
									value: tokens.refresh_token,
									target: [target],
									type: 'encrypted',
								}),
							},
						)
						const body = await resp.text()
						const bodyPreview = body.slice(0, 200)
						storeResults.push({
							target,
							ok: resp.ok,
							status: resp.status,
							bodyPreview,
						})

						if (resp.ok) {
							await emitAuthLog(
								'info',
								'youtube-auth.vercel-env-write.succeeded',
								{
									requestId,
									target,
									status: resp.status,
									refreshTokenFingerprint,
								},
							)
						} else {
							await emitAuthLog(
								'warn',
								'youtube-auth.vercel-env-write.failed',
								{
									requestId,
									target,
									status: resp.status,
									bodyPreview,
									refreshTokenFingerprint,
								},
							)
						}
					}

					stored = storeResults.every((result) => result.ok)
					await emitAuthLog('info', 'youtube-auth.vercel-env-write.completed', {
						requestId,
						stored,
						storeResults,
						refreshTokenFingerprint,
					})

					if (stored) {
						const redeployResp = await fetch(
							`https://api.vercel.com/v13/deployments${redeployQuery}`,
							{
								method: 'POST',
								headers: {
									Authorization: `Bearer ${vercelToken}`,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									name: 'ai-hero',
									target: 'production',
									gitSource: {
										type: 'github',
										repo: 'course-builder',
										ref: 'main',
										org: 'badass-courses',
									},
								}),
							},
						)
						const redeployBodyPreview = (await redeployResp.text()).slice(
							0,
							200,
						)
						if (redeployResp.ok) {
							await emitAuthLog('info', 'youtube-auth.redeploy-triggered', {
								requestId,
								status: redeployResp.status,
								refreshTokenFingerprint,
							})
						} else {
							await emitAuthLog('warn', 'youtube-auth.redeploy-failed', {
								requestId,
								status: redeployResp.status,
								bodyPreview: redeployBodyPreview,
								refreshTokenFingerprint,
							})
						}
					}
				} catch (storeErr) {
					await emitAuthLog('error', 'youtube-auth.vercel-store.failed', {
						requestId,
						refreshTokenFingerprint,
						error: serializeError(storeErr),
					})
				}
			} else {
				await emitAuthLog('warn', 'youtube-auth.vercel-store.skipped', {
					requestId,
					hasVercelToken: Boolean(vercelToken),
					hasProjectId: Boolean(projectId),
					refreshTokenFingerprint,
				})
			}

			return createHtmlResponse(
				'<h1>✅ YouTube authorized</h1>',
				`${
					stored
						? '<p style="color:#16a34a;font-weight:600">Refresh token stored automatically. No further action needed.</p>'
						: '<p>Authorization succeeded, but token storage did not fully complete. Check the youtube-auth logs or /api/analytics/youtube-auth?verify=1 before asking Matt to retry.</p>'
				}<p style="color:#666;font-size:13px;margin-top:16px">Analytics plus YouTube channel management access granted. This refresh token stays valid until revoked. You can close this tab.</p>`,
				true,
			)
		} catch (err) {
			await emitAuthLog('error', 'youtube-auth.token-exchange.failed', {
				requestId,
				callbackScopes,
				error: serializeError(err),
			})
			return createHtmlResponse(
				'<h1>❌ Token exchange failed</h1>',
				`<p>${err instanceof Error ? err.message : 'Unknown error'}</p>`,
				true,
			)
		}
	}

	const { ability } = await getServerAuthSession()
	if (ability.cannot('manage', 'all')) {
		await emitAuthLog('warn', 'youtube-auth.start.unauthorized', {
			requestId,
		})
		return NextResponse.json(
			{ error: 'Unauthorized, admin only' },
			{ status: 401 },
		)
	}

	const oauth2Client = getOAuth2Client()
	const state = randomUUID()
	const authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		include_granted_scopes: true,
		prompt: 'consent',
		scope: SCOPES,
		state,
	})

	await emitAuthLog('info', 'youtube-auth.start.redirecting', {
		requestId: state,
		requestedScopes,
		redirectUri: REDIRECT_URI,
	})

	await log.flush()
	const response = NextResponse.redirect(authUrl)
	response.cookies.set(STATE_COOKIE_NAME, state, getStateCookieOptions())
	return response
})
