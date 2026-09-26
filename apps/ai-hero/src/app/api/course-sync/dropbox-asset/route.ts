import { dropboxSyncConfigFor } from '@/course-sync/dropbox-binding-config'
import { verifyDropboxMuxProxyToken } from '@/course-sync/dropbox-mux-source'
import { CourseSyncError } from '@/course-sync/errors'
import { getServerCourseSyncBinding } from '@/course-sync/types'
import { env } from '@/env.mjs'
import { createDropboxSharedLinkAssetReader } from '@/lib/dropbox-course-sync'

export const maxDuration = 800

export async function GET(request: Request) {
	const url = new URL(request.url)
	const bindingId = url.searchParams.get('binding') ?? ''
	const relativePath = url.searchParams.get('path') ?? ''
	const expiresAt = Number(url.searchParams.get('expires'))
	const suppliedSignature = url.searchParams.get('signature') ?? ''
	if (!env.NEXTAUTH_SECRET) {
		return new Response('Course-sync asset signing is not configured.', {
			status: 503,
		})
	}
	if (!bindingId) {
		return new Response('Missing course-sync binding.', { status: 400 })
	}
	let binding
	try {
		binding = getServerCourseSyncBinding(bindingId)
	} catch (error) {
		if (error instanceof CourseSyncError && error.code === 'BINDING_NOT_FOUND') {
			return new Response('Course-sync binding not found.', { status: 404 })
		}
		throw error
	}
	if (
		!verifyDropboxMuxProxyToken({
			bindingId,
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

	const { config } = dropboxSyncConfigFor(binding)
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
