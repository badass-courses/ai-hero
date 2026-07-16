import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
	buildDropboxAuthorizationUrl,
	exchangeDropboxAuthorizationCode,
	getDropboxSyncConfig,
	redeployAfterDropboxAuthorization,
	storeDropboxRefreshToken,
	verifyDropboxConnection,
} from '@/lib/dropbox-course-sync'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const STATE_COOKIE_NAME = 'dropbox_course_sync_state'
const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10
const STATE_COOKIE_PATH = '/api/integrations/dropbox'

function stateCookieOptions() {
	return {
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		path: STATE_COOKIE_PATH,
		maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
	}
}

function html(title: string, body: string) {
	return `<!doctype html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px"><h1>${title}</h1>${body}</body></html>`
}

function page(title: string, body: string, clearState = false) {
	const response = new NextResponse(html(title, body), {
		headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
	})
	if (clearState) {
		response.cookies.set(STATE_COOKIE_NAME, '', {
			...stateCookieOptions(),
			maxAge: 0,
		})
	}
	return response
}

async function requireAdmin() {
	const { ability } = await getServerAuthSession()
	return ability.can('manage', 'all')
}

function tokenStoreIsConfigured() {
	return Boolean(process.env.VERCEL_API_TOKEN && process.env.VERCEL_AI_HERO_PROJECT_ID)
}

/**
 * GET /api/integrations/dropbox
 *
 * - no query parameters: start a state-protected OAuth authorization flow
 * - `?code=...&state=...`: verify Dropbox access and store the refresh token in Vercel encrypted env
 * - `?verify=1`: confirm the stored token can read the configured shared folder and approved root
 */
export const GET = withSkill(async (request: NextRequest) => {
	const url = new URL(request.url)
	const verify = url.searchParams.get('verify') === '1'
	const code = url.searchParams.get('code')
	const oauthError = url.searchParams.get('error')
	const stateFromQuery = url.searchParams.get('state')
	const stateFromCookie = request.cookies.get(STATE_COOKIE_NAME)?.value ?? null
	const requestId = stateFromQuery ?? stateFromCookie ?? randomUUID()
	const { config, missingConfig } = getDropboxSyncConfig()

	if (verify) {
		if (!(await requireAdmin())) {
			return NextResponse.json({ ok: false, error: 'Unauthorized, admin only' }, { status: 401 })
		}

		const verification = await verifyDropboxConnection({
			config,
			refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
		})
		await log.info('dropbox-course-sync.verify.completed', {
			requestId,
			ok: verification.ok,
			configured: verification.configured,
			missingConfig: verification.missingConfig,
			requiredScopesPresent: verification.requiredScopesPresent,
			accountIdFingerprint: verification.accountIdFingerprint,
			sharedFolderVerified: verification.sharedFolderBoundary.verified,
		})
		return NextResponse.json(verification, {
			status: verification.ok ? 200 : 500,
			headers: { 'Cache-Control': 'no-store' },
		})
	}

	if (oauthError) {
		await log.warn('dropbox-course-sync.callback.denied', {
			requestId,
			oauthError,
			statePresent: Boolean(stateFromQuery),
		})
		return page('Dropbox authorization denied', '<p>You can close this tab and start again.</p>', true)
	}

	if (code) {
		if (!stateFromQuery || !stateFromCookie || stateFromQuery !== stateFromCookie) {
			await log.warn('dropbox-course-sync.callback.state-mismatch', {
				requestId,
				statePresent: Boolean(stateFromQuery),
				stateCookiePresent: Boolean(stateFromCookie),
			})
			return page('Authorization could not be verified', '<p>The OAuth state check failed. Start the flow again from AI Hero.</p>', true)
		}
		if (!config) {
			await log.error('dropbox-course-sync.callback.misconfigured', { requestId, missingConfig })
			return page('Dropbox connection is not configured', '<p>Configure the Dropbox app and one approved shared source, either a shared link or a shared-folder ID plus approved root, before retrying.</p>', true)
		}

		try {
			const { refreshToken, grantedScopes } = await exchangeDropboxAuthorizationCode({ code, config })
			const verification = await verifyDropboxConnection({ config, refreshToken })
			if (!verification.ok || !verification.requiredScopesPresent || !verification.sharedFolderBoundary.verified) {
				await log.warn('dropbox-course-sync.callback.boundary-failed', {
					requestId,
					requiredScopesPresent: verification.requiredScopesPresent,
					sharedFolderVerified: verification.sharedFolderBoundary.verified,
				})
				return page('Dropbox connection could not be verified', '<p>AI Hero could not confirm the approved shared-folder boundary. No credential was stored. Fix the folder configuration and start again.</p>', true)
			}

			const storage = await storeDropboxRefreshToken({ refreshToken })
			if (!storage.ok) {
				await log.error('dropbox-course-sync.callback.secret-store-failed', {
					requestId,
					missingConfig: storage.missingConfig,
					statuses: storage.statuses,
				})
				return page('Dropbox authorization was not stored', '<p>AI Hero could not save the credential to its encrypted runtime configuration. No credential was displayed. Fix the server configuration and start again.</p>', true)
			}

			const redeploy = await redeployAfterDropboxAuthorization()
			if (!redeploy.ok) {
				await log.error('dropbox-course-sync.callback.redeploy-failed', {
					requestId,
					missingConfig: redeploy.missingConfig,
					status: redeploy.status,
				})
				return page('Dropbox credential was stored, but AI Hero was not redeployed', '<p>The credential is safely stored, but the running app cannot use it until a new production deployment succeeds. Trigger a production deployment, then run the verification endpoint.</p>', true)
			}

			await log.info('dropbox-course-sync.callback.succeeded', {
				requestId,
				grantedScopes,
				accountIdFingerprint: verification.accountIdFingerprint,
				sharedFolderVerified: verification.sharedFolderBoundary.verified,
				redeployStatus: redeploy.status,
			})
			return page('Dropbox authorized', '<p>AI Hero verified the approved shared folder, stored the refresh credential in encrypted runtime configuration, and triggered a production deployment. You can close this tab.</p>', true)
		} catch (error) {
			await log.error('dropbox-course-sync.callback.failed', {
				requestId,
				error: error instanceof Error ? error.message : 'Unknown error',
			})
			return page('Dropbox authorization failed', '<p>No credential was stored. Fix the configuration and start the flow again.</p>', true)
		}
	}

	if (!(await requireAdmin())) {
		return NextResponse.json({ ok: false, error: 'Unauthorized, admin only' }, { status: 401 })
	}
	if (!config || !tokenStoreIsConfigured()) {
		await log.warn('dropbox-course-sync.start.misconfigured', {
			requestId,
			missingConfig: [
				...missingConfig,
				...(tokenStoreIsConfigured() ? [] : ['VERCEL_API_TOKEN', 'VERCEL_AI_HERO_PROJECT_ID']),
			],
		})
		return NextResponse.json(
			{
				ok: false,
				error: 'Dropbox sync is not configured. No authorization flow was started.',
			},
			{ status: 503 },
		)
	}

	const authorization = buildDropboxAuthorizationUrl(config)
	await log.info('dropbox-course-sync.start.redirecting', {
		requestId: authorization.state,
		redirectUri: config.redirectUri,
	})
	const response = NextResponse.redirect(authorization.url)
	response.cookies.set(STATE_COOKIE_NAME, authorization.state, stateCookieOptions())
	return response
})
