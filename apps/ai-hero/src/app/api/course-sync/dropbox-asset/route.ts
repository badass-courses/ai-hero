import { verifyDropboxMuxProxyToken } from '@/course-sync/dropbox-mux-source'
import { env } from '@/env.mjs'
import {
	createDropboxSharedLinkAssetReader,
	getDropboxSyncConfig,
} from '@/lib/dropbox-course-sync'

export const maxDuration = 800

export async function GET(request: Request) {
	const url = new URL(request.url)
	const relativePath = url.searchParams.get('path') ?? ''
	const expiresAt = Number(url.searchParams.get('expires'))
	const suppliedSignature = url.searchParams.get('signature') ?? ''
	if (!env.NEXTAUTH_SECRET) {
		return new Response('Course-sync asset signing is not configured.', {
			status: 503,
		})
	}
	if (
		!verifyDropboxMuxProxyToken({
			relativePath,
			expiresAt,
			suppliedSignature,
			signingSecret: env.NEXTAUTH_SECRET,
		})
	) {
		return new Response('Invalid or expired course-sync asset URL.', {
			status: 403,
		})
	}

	const { config } = getDropboxSyncConfig({
		DROPBOX_APP_KEY: env.DROPBOX_APP_KEY,
		DROPBOX_APP_SECRET: env.DROPBOX_APP_SECRET,
		DROPBOX_OAUTH_REDIRECT_URI: env.DROPBOX_OAUTH_REDIRECT_URI,
		DROPBOX_SYNC_SHARED_FOLDER_ID: env.DROPBOX_SYNC_SHARED_FOLDER_ID,
		DROPBOX_SYNC_ALLOWED_ROOT: env.DROPBOX_SYNC_ALLOWED_ROOT,
		DROPBOX_SYNC_SHARED_LINK: env.DROPBOX_SYNC_SHARED_LINK,
	})
	if (!config || !env.DROPBOX_REFRESH_TOKEN) {
		return new Response('Dropbox course sync is not configured.', { status: 503 })
	}
	if (config.source.kind !== 'shared-link') {
		return new Response('The course-sync proxy requires a shared-link source.', {
			status: 409,
		})
	}

	const reader = await createDropboxSharedLinkAssetReader({
		config,
		refreshToken: env.DROPBOX_REFRESH_TOKEN,
	})
	const asset = await reader.read(relativePath)
	return new Response(asset.stream, {
		headers: {
			'Content-Length': String(asset.bytes),
			'Content-Type': 'video/mp4',
			'Cache-Control': 'private, no-store',
			'X-Course-Sync-Dropbox-Rev': asset.providerRevision,
		},
	})
}
