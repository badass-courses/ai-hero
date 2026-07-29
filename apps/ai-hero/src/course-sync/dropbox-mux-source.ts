import { createHmac, timingSafeEqual } from 'node:crypto'
import {
	refreshDropboxAccessToken,
	type DropboxSyncConfig,
} from '@/lib/dropbox-course-sync'

import { CourseSyncError } from './errors'
import type {
	CourseSyncMuxSourceResolver,
	DropboxMuxSource,
} from './types'

type Fetch = typeof fetch

type DropboxMetadata = {
	id?: string
	path_lower?: string
	rev?: string
	content_hash?: string
	size?: number
}

async function dropboxJson(
	fetchImpl: Fetch,
	accessToken: string,
	path: string,
	body: Record<string, unknown>,
) {
	const response = await fetchImpl(`https://api.dropboxapi.com/2${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
	const text = await response.text()
	if (!response.ok) {
		throw new CourseSyncError(
			'DROPBOX_MUX_SOURCE_FAILED',
			`Dropbox ${path} failed (${response.status}): ${text
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 300)}`,
			502,
		)
	}
	return JSON.parse(text) as Record<string, unknown>
}

function directDownloadUrl(sharedLink: string) {
	const url = new URL(sharedLink)
	url.searchParams.delete('raw')
	url.searchParams.set('dl', '1')
	return url.toString()
}

function signature(secret: string, relativePath: string, expiresAt: number) {
	return createHmac('sha256', secret)
		.update(`${expiresAt}:${relativePath}`)
		.digest('base64url')
}

export function createDropboxMuxProxyUrl(input: {
	baseUrl: string
	relativePath: string
	expiresAt: number
	signingSecret: string
}) {
	const url = new URL('/api/course-sync/dropbox-asset', input.baseUrl)
	url.searchParams.set('path', input.relativePath)
	url.searchParams.set('expires', String(input.expiresAt))
	url.searchParams.set(
		'signature',
		signature(input.signingSecret, input.relativePath, input.expiresAt),
	)
	return url.toString()
}

export function verifyDropboxMuxProxyToken(input: {
	relativePath: string
	expiresAt: number
	suppliedSignature: string
	signingSecret: string
	now?: number
}) {
	if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= (input.now ?? Date.now())) {
		return false
	}
	const expected = Buffer.from(
		signature(input.signingSecret, input.relativePath, input.expiresAt),
	)
	const supplied = Buffer.from(input.suppliedSignature)
	return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

function metadataReceipt(metadata: DropboxMetadata): Omit<DropboxMuxSource, 'url'> {
	if (
		!metadata.rev ||
		typeof metadata.size !== 'number' ||
		!Number.isSafeInteger(metadata.size)
	) {
		throw new CourseSyncError(
			'DROPBOX_ASSET_METADATA_INVALID',
			'Dropbox asset metadata did not include a revision and byte count.',
			502,
		)
	}
	return {
		providerRevision: metadata.rev,
		providerContentHash: metadata.content_hash ?? null,
		bytes: metadata.size,
	}
}

export function createDropboxMuxSourceResolver(input: {
	config: DropboxSyncConfig
	refreshToken: string
	baseUrl: string
	signingSecret: string
	fetchImpl?: Fetch
	clock?: () => number
}): CourseSyncMuxSourceResolver {
	const fetchImpl = input.fetchImpl ?? fetch
	let accessToken: Promise<string> | null = null
	const token = async () => {
		accessToken ??= refreshDropboxAccessToken({
			refreshToken: input.refreshToken,
			config: input.config,
			fetchImpl,
		}).then((result) => result.accessToken)
		return accessToken
	}

	return {
		async resolve({ relativePath }) {
			const accessToken = await token()
			const path = `/${relativePath}`
			let metadata: DropboxMetadata
			if (input.config.source.kind === 'shared-link') {
				metadata = (await dropboxJson(
					fetchImpl,
					accessToken,
					'/sharing/get_shared_link_metadata',
					{ url: input.config.source.sharedLink, path },
				)) as DropboxMetadata
			} else {
				metadata = (await dropboxJson(
					fetchImpl,
					accessToken,
					'/files/get_metadata',
					{ path: `${input.config.source.allowedRoot.replace(/\/$/, '')}${path}` },
				)) as DropboxMetadata
			}
			const receipt = metadataReceipt(metadata)

			if (metadata.path_lower) {
				try {
					const temporary = await dropboxJson(
						fetchImpl,
						accessToken,
						'/files/get_temporary_link',
						{ path: metadata.path_lower },
					)
					if (typeof temporary.link === 'string') {
						return { ...receipt, url: temporary.link }
					}
				} catch {
					// The shared-link namespace may not be mounted in this account.
				}

				try {
					const shared = await dropboxJson(
						fetchImpl,
						accessToken,
						'/sharing/create_shared_link_with_settings',
						{ path: metadata.path_lower },
					)
					if (typeof shared.url === 'string') {
						return { ...receipt, url: directDownloadUrl(shared.url) }
					}
				} catch {
					// Read-only Dropbox grants cannot create per-file links.
				}
			}

			const now = input.clock?.() ?? Date.now()
			return {
				...receipt,
				url: createDropboxMuxProxyUrl({
					baseUrl: input.baseUrl,
					relativePath,
					expiresAt: now + 6 * 60 * 60 * 1000,
					signingSecret: input.signingSecret,
				}),
			}
		},
	}
}
