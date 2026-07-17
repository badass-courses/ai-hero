import { createHash, randomUUID } from 'node:crypto'

export const DROPBOX_OAUTH_CALLBACK_PATH = '/api/integrations/dropbox'
export const DEFAULT_DROPBOX_OAUTH_REDIRECT_URI = `https://www.aihero.dev${DROPBOX_OAUTH_CALLBACK_PATH}`
export const DROPBOX_REQUIRED_SCOPES = [
	'account_info.read',
	'files.metadata.read',
	'files.content.read',
	'sharing.read',
] as const
export const MAX_DROPBOX_COURSE_MANIFEST_BYTES = 5 * 1024 * 1024

export type DropboxSharedSource =
	| { kind: 'folder'; sharedFolderId: string; allowedRoot: string }
	| { kind: 'shared-link'; sharedLink: string }

export type DropboxSyncConfig = {
	appKey: string
	appSecret: string
	redirectUri: string
	source: DropboxSharedSource
}

type Environment = Record<string, string | undefined>
type Fetch = typeof fetch

type DropboxTokenResponse = {
	access_token?: string
	refresh_token?: string
	scope?: string
	expires_in?: number
}

export type DropboxConnectionVerification = {
	ok: boolean
	configured: boolean
	missingConfig: string[]
	grantedScopes: string[]
	requiredScopesPresent: boolean
	accountIdFingerprint: string | null
	sharedFolderBoundary: {
		configured: boolean
		verified: boolean
	}
}

export type DropboxCourseManifestSummary = {
	schema: 'aihero.course-sync.v1'
	producer: {
		name: 'course-video-manager'
		revision: string | null
		exportedAt: string
	}
	course: {
		sourceId: string
		versionSourceId: string
	}
	structure: {
		sectionCount: number
		lessonCount: number
		videoCount: number
		declaredAssetCount: number
		declaredAssetsMissingSha256: number
		videoMediaCount: number
		videoMediaMissingSha256: number
	}
	manifest: {
		sourcePath: '/course.json'
		id: string | null
		rev: string
		contentHash: string | null
		bytes: number
		serverModified: string | null
		sha256: string
	}
}

export type DropboxTokenStoreResult = {
	ok: boolean
	missingConfig: string[]
	statuses: number[]
}

export type DropboxRedeployResult = {
	ok: boolean
	missingConfig: string[]
	status: number | null
}

export function getDropboxSyncConfig(
	environment: Environment = process.env,
): { config: DropboxSyncConfig | null; missingConfig: string[] } {
	const appKey = environment.DROPBOX_APP_KEY
	const appSecret = environment.DROPBOX_APP_SECRET
	const sharedFolderId = environment.DROPBOX_SYNC_SHARED_FOLDER_ID
	const allowedRoot = environment.DROPBOX_SYNC_ALLOWED_ROOT
	const sharedLink = environment.DROPBOX_SYNC_SHARED_LINK
	const redirectUri =
		environment.DROPBOX_OAUTH_REDIRECT_URI ?? DEFAULT_DROPBOX_OAUTH_REDIRECT_URI
	const source = sharedLink
		? ({ kind: 'shared-link', sharedLink } as const)
		: sharedFolderId && allowedRoot
			? ({ kind: 'folder', sharedFolderId, allowedRoot } as const)
			: null

	const missingConfig = [
		!appKey ? 'DROPBOX_APP_KEY' : null,
		!appSecret ? 'DROPBOX_APP_SECRET' : null,
		!source ? 'DROPBOX_SYNC_SHARED_LINK or DROPBOX_SYNC_SHARED_FOLDER_ID plus DROPBOX_SYNC_ALLOWED_ROOT' : null,
	].filter(Boolean) as string[]

	if (missingConfig.length > 0 || !appKey || !appSecret || !source) {
		return { config: null, missingConfig }
	}

	return {
		config: { appKey, appSecret, redirectUri, source },
		missingConfig: [],
	}
}

export function buildDropboxAuthorizationUrl(
	config: DropboxSyncConfig,
	state: string = randomUUID(),
) {
	const url = new URL('https://www.dropbox.com/oauth2/authorize')
	url.searchParams.set('client_id', config.appKey)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('redirect_uri', config.redirectUri)
	url.searchParams.set('token_access_type', 'offline')
	url.searchParams.set('scope', DROPBOX_REQUIRED_SCOPES.join(' '))
	url.searchParams.set('state', state)
	return { state, url: url.toString() }
}

export function parseDropboxScopes(value: string | undefined): string[] {
	return value
		?.split(' ')
		.map((scope) => scope.trim())
		.filter(Boolean) ?? []
}

export function hasRequiredDropboxScopes(scopes: readonly string[]) {
	return DROPBOX_REQUIRED_SCOPES.every((scope) => scopes.includes(scope))
}

export function fingerprintDropboxSecret(value: string | null | undefined) {
	if (!value) return null
	return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function isWithinSharedFolder(rootPath: unknown, sharedFolderPath: unknown) {
	if (typeof rootPath !== 'string' || typeof sharedFolderPath !== 'string') return false
	const root = rootPath.toLowerCase()
	const folder = sharedFolderPath.toLowerCase()
	return root === folder || root.startsWith(`${folder}/`)
}

export async function exchangeDropboxAuthorizationCode({
	code,
	config,
	fetchImpl = fetch,
}: {
	code: string
	config: DropboxSyncConfig
	fetchImpl?: Fetch
}): Promise<{ refreshToken: string; grantedScopes: string[] }> {
	const response = await fetchImpl('https://api.dropboxapi.com/oauth2/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			grant_type: 'authorization_code',
			redirect_uri: config.redirectUri,
			client_id: config.appKey,
			client_secret: config.appSecret,
		}).toString(),
	})

	if (!response.ok) {
		throw new Error(`Dropbox authorization exchange failed (${response.status})`)
	}

	const token = (await response.json()) as DropboxTokenResponse
	const grantedScopes = parseDropboxScopes(token.scope)

	if (!token.refresh_token) {
		throw new Error('Dropbox did not return a refresh token. Start the authorization flow again.')
	}
	if (!hasRequiredDropboxScopes(grantedScopes)) {
		throw new Error('Dropbox did not grant the required read-only scopes.')
	}

	return { refreshToken: token.refresh_token, grantedScopes }
}

async function refreshDropboxAccessToken({
	refreshToken,
	config,
	fetchImpl,
}: {
	refreshToken: string
	config: DropboxSyncConfig
	fetchImpl: Fetch
}): Promise<{ accessToken: string; grantedScopes: string[] }> {
	const response = await fetchImpl('https://api.dropboxapi.com/oauth2/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			refresh_token: refreshToken,
			grant_type: 'refresh_token',
			client_id: config.appKey,
			client_secret: config.appSecret,
		}).toString(),
	})

	if (!response.ok) {
		throw new Error(`Dropbox refresh failed (${response.status})`)
	}

	const token = (await response.json()) as DropboxTokenResponse
	if (!token.access_token) {
		throw new Error('Dropbox refresh response did not contain an access token.')
	}

	return {
		accessToken: token.access_token,
		grantedScopes: parseDropboxScopes(token.scope),
	}
}

async function dropboxJson({
	path,
	accessToken,
	body,
	fetchImpl,
}: {
	path: string
	accessToken: string
	body: Record<string, unknown>
	fetchImpl: Fetch
}) {
	const response = await fetchImpl(`https://api.dropboxapi.com/2${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (!response.ok) {
		throw new Error(`Dropbox ${path} failed (${response.status})`)
	}

	return response.json() as Promise<Record<string, unknown>>
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function requiredString(
	record: Record<string, unknown> | null,
	key: string,
	error: string,
) {
	const value = record?.[key]
	if (typeof value !== 'string' || value.length === 0) throw new Error(error)
	return value
}

function optionalString(record: Record<string, unknown>, key: string) {
	const value = record[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

export async function readDropboxCourseManifestSummary({
	config,
	refreshToken,
	fetchImpl = fetch,
}: {
	config: DropboxSyncConfig
	refreshToken: string
	fetchImpl?: Fetch
}): Promise<DropboxCourseManifestSummary> {
	if (config.source.kind !== 'shared-link') {
		throw new Error('Dropbox course manifest reads require the approved shared-link boundary.')
	}

	const { accessToken } = await refreshDropboxAccessToken({
		refreshToken,
		config,
		fetchImpl,
	})
	const response = await fetchImpl(
		'https://content.dropboxapi.com/2/sharing/get_shared_link_file',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Dropbox-API-Arg': JSON.stringify({
					url: config.source.sharedLink,
					path: '/course.json',
				}),
			},
		},
	)
	if (!response.ok) {
		throw new Error(`Dropbox course manifest read failed (${response.status})`)
	}

	const metadataHeader = response.headers.get('Dropbox-API-Result')
	if (!metadataHeader) throw new Error('Dropbox course manifest metadata was missing.')

	const metadata = asRecord(JSON.parse(metadataHeader))
	const metadataSize = metadata?.size
	if (typeof metadataSize !== 'number' || !Number.isSafeInteger(metadataSize) || metadataSize < 0) {
		throw new Error('Dropbox course manifest size was missing or invalid.')
	}
	if (metadataSize > MAX_DROPBOX_COURSE_MANIFEST_BYTES) {
		throw new Error('Dropbox course manifest exceeds the maximum allowed size.')
	}

	const bytes = new Uint8Array(await response.arrayBuffer())
	if (bytes.byteLength > MAX_DROPBOX_COURSE_MANIFEST_BYTES) {
		throw new Error('Dropbox course manifest exceeds the maximum allowed size.')
	}
	const manifestSha256 = createHash('sha256').update(bytes).digest('hex')
	const document = asRecord(JSON.parse(new TextDecoder().decode(bytes)))
	const producer = asRecord(document?.producer)
	const course = asRecord(document?.course)
	const version = asRecord(course?.version)

	if (document?.schema !== 'aihero.course-sync.v1') {
		throw new Error('Dropbox course manifest schema is not aihero.course-sync.v1.')
	}
	if (producer?.name !== 'course-video-manager') {
		throw new Error('Dropbox course manifest producer is not course-video-manager.')
	}

	if (!Array.isArray(document.sections)) {
		throw new Error('Dropbox course manifest sections were missing or invalid.')
	}
	const sections = document.sections.map((section) => {
		const record = asRecord(section)
		if (!record) throw new Error('Dropbox course manifest section was invalid.')
		return record
	})
	const lessons = sections.flatMap((section) => {
		const value = section.lessons
		if (!Array.isArray(value)) {
			throw new Error('Dropbox course manifest section lessons were missing or invalid.')
		}
		return value.map((lesson) => {
			const record = asRecord(lesson)
			if (!record) throw new Error('Dropbox course manifest lesson was invalid.')
			return record
		})
	})
	const videos = lessons.flatMap((lesson) => {
		const value = lesson.videos
		if (!Array.isArray(value)) {
			throw new Error('Dropbox course manifest lesson videos were missing or invalid.')
		}
		return value.map((video) => {
			const record = asRecord(video)
			if (!record) throw new Error('Dropbox course manifest video was invalid.')
			return record
		})
	})
	if (document.assets !== undefined && !Array.isArray(document.assets)) {
		throw new Error('Dropbox course manifest assets were invalid.')
	}
	const declaredAssets = Array.isArray(document.assets)
		? document.assets.map((asset) => {
				const record = asRecord(asset)
				if (!record) throw new Error('Dropbox course manifest asset was invalid.')
				return record
			})
		: []
	const videoMedia = videos
		.map((video) => {
			if (video.media === undefined) return null
			const record = asRecord(video.media)
			if (!record) throw new Error('Dropbox course manifest video media was invalid.')
			return record
		})
		.filter((media): media is Record<string, unknown> => media !== null)

	return {
		schema: 'aihero.course-sync.v1',
		producer: {
			name: 'course-video-manager',
			revision: optionalString(producer, 'revision'),
			exportedAt: requiredString(
				producer,
				'exportedAt',
				'Dropbox course manifest producer exportedAt was missing.',
			),
		},
		course: {
			sourceId: requiredString(
				course,
				'sourceId',
				'Dropbox course manifest course sourceId was missing.',
			),
			versionSourceId: requiredString(
				version,
				'sourceId',
				'Dropbox course manifest version sourceId was missing.',
			),
		},
		structure: {
			sectionCount: sections.length,
			lessonCount: lessons.length,
			videoCount: videos.length,
			declaredAssetCount: declaredAssets.length,
			declaredAssetsMissingSha256: declaredAssets.filter(
				(asset) => typeof asRecord(asset)?.sha256 !== 'string',
			).length,
			videoMediaCount: videoMedia.length,
			videoMediaMissingSha256: videoMedia.filter(
				(media) => typeof media.sha256 !== 'string',
			).length,
		},
		manifest: {
			sourcePath: '/course.json',
			id: optionalString(metadata ?? {}, 'id'),
			rev: requiredString(
				metadata,
				'rev',
				'Dropbox course manifest revision was missing.',
			),
			contentHash: optionalString(metadata ?? {}, 'content_hash'),
			bytes: metadataSize,
			serverModified: optionalString(metadata ?? {}, 'server_modified'),
			sha256: manifestSha256,
		},
	}
}

export async function verifyDropboxConnection({
	config,
	refreshToken,
	fetchImpl = fetch,
}: {
	config: DropboxSyncConfig | null
	refreshToken: string | null | undefined
	fetchImpl?: Fetch
}): Promise<DropboxConnectionVerification> {
	const missingConfig = [
		!config ? 'Dropbox sync configuration' : null,
		!refreshToken ? 'DROPBOX_REFRESH_TOKEN' : null,
	].filter(Boolean) as string[]
	const initial: DropboxConnectionVerification = {
		ok: false,
		configured: missingConfig.length === 0,
		missingConfig,
		grantedScopes: [],
		requiredScopesPresent: false,
		accountIdFingerprint: null,
		sharedFolderBoundary: {
			configured: Boolean(config?.source),
			verified: false,
		},
	}

	if (!config || !refreshToken) return initial

	try {
		const { accessToken, grantedScopes } = await refreshDropboxAccessToken({
			refreshToken,
			config,
			fetchImpl,
		})
		const account = await dropboxJson({
			path: '/users/get_current_account',
			accessToken,
			body: {},
			fetchImpl,
		})
		if (config.source.kind === 'shared-link') {
			const sharedRoot = await dropboxJson({
				path: '/sharing/get_shared_link_metadata',
				accessToken,
				body: { url: config.source.sharedLink },
				fetchImpl,
			})
			const courseJson = await dropboxJson({
				path: '/sharing/get_shared_link_metadata',
				accessToken,
				body: { url: config.source.sharedLink, path: '/course.json' },
				fetchImpl,
			})
			if (sharedRoot['.tag'] !== 'folder' || courseJson['.tag'] !== 'file') {
				return initial
			}
		} else {
			const sharedFolder = await dropboxJson({
				path: '/sharing/get_folder_metadata',
				accessToken,
				body: { shared_folder_id: config.source.sharedFolderId },
				fetchImpl,
			})
			const allowedRoot = await dropboxJson({
				path: '/files/get_metadata',
				accessToken,
				body: { path: config.source.allowedRoot },
				fetchImpl,
			})
			if (!isWithinSharedFolder(allowedRoot.path_lower, sharedFolder.path_lower)) {
				return initial
			}
		}

		return {
			...initial,
			ok: true,
			grantedScopes,
			requiredScopesPresent:
				grantedScopes.length === 0 || hasRequiredDropboxScopes(grantedScopes),
			accountIdFingerprint: fingerprintDropboxSecret(
				typeof account.account_id === 'string' ? account.account_id : null,
			),
			sharedFolderBoundary: { configured: true, verified: true },
		}
	} catch {
		return initial
	}
}

export async function storeDropboxRefreshToken({
	refreshToken,
	environment = process.env,
	fetchImpl = fetch,
}: {
	refreshToken: string
	environment?: Environment
	fetchImpl?: Fetch
}): Promise<DropboxTokenStoreResult> {
	const vercelToken = environment.VERCEL_API_TOKEN
	const projectId = environment.VERCEL_AI_HERO_PROJECT_ID
	const teamId = environment.VERCEL_TEAM_ID
	const missingConfig = [
		!vercelToken ? 'VERCEL_API_TOKEN' : null,
		!projectId ? 'VERCEL_AI_HERO_PROJECT_ID' : null,
	].filter(Boolean) as string[]

	if (missingConfig.length > 0 || !vercelToken || !projectId) {
		return { ok: false, missingConfig, statuses: [] }
	}

	const query = new URLSearchParams({ upsert: 'true' })
	if (teamId) query.set('teamId', teamId)
	const url = `https://api.vercel.com/v10/projects/${projectId}/env?${query.toString()}`
	const statuses: number[] = []

	for (const target of ['production', 'preview', 'development']) {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${vercelToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				key: 'DROPBOX_REFRESH_TOKEN',
				value: refreshToken,
				target: [target],
				type: 'encrypted',
			}),
		})
		statuses.push(response.status)
	}

	return { ok: statuses.every((status) => status >= 200 && status < 300), missingConfig: [], statuses }
}

export async function redeployAfterDropboxAuthorization(
	{
		environment = process.env,
		fetchImpl = fetch,
	}: {
		environment?: Environment
		fetchImpl?: Fetch
	} = {},
): Promise<DropboxRedeployResult> {
	const vercelToken = environment.VERCEL_API_TOKEN
	const teamId = environment.VERCEL_TEAM_ID
	const missingConfig = [!vercelToken ? 'VERCEL_API_TOKEN' : null].filter(Boolean) as string[]
	if (!vercelToken) return { ok: false, missingConfig, status: null }

	const query = new URLSearchParams()
	if (teamId) query.set('teamId', teamId)
	const response = await fetchImpl(
		`https://api.vercel.com/v13/deployments${query.size > 0 ? `?${query.toString()}` : ''}`,
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
					repo: 'ai-hero',
					ref: 'main',
					org: 'badass-courses',
				},
			}),
		},
	)

	return {
		ok: response.ok,
		missingConfig: [],
		status: response.status,
	}
}
