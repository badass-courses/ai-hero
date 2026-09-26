import { z } from 'zod'

import { env } from '@/env.mjs'
import { getDropboxSyncConfig } from '@/lib/dropbox-course-sync'

import { CourseSyncError } from './errors'
import type { CourseSyncBinding } from './types'

const sharedLinkUrl = z.string().url()

/** Keep each environment access static so Next includes both optional links. */
export function sharedLinkFor(binding: CourseSyncBinding): string | undefined {
	let link: string | undefined
	switch (binding.sharedLinkSecretRef) {
		case 'DROPBOX_SYNC_SHARED_LINK':
			link = env.DROPBOX_SYNC_SHARED_LINK
			break
		case 'DROPBOX_SYNC_SHARED_LINK_COHORT_005':
			link = env.DROPBOX_SYNC_SHARED_LINK_COHORT_005
			break
		default: {
			const unreachable: never = binding
			return unreachable
		}
	}
	// v5 has no shared-folder fallback: a missing cohort link must not read
	// Crash Course's folder. v4 retains its original optional link fallback.
	if (binding.contractVersion === 5 && !link) {
		throw new CourseSyncError(
			'SOURCE_CONFIG_INVALID',
			`Missing Dropbox shared link for ${binding.sharedLinkSecretRef}.`,
			503,
		)
	}
	// Preserve the original Crash Course z.string().url() rule, but move it
	// out of createEnv so one bad binding cannot prevent the app from loading.
	if (link !== undefined && !sharedLinkUrl.safeParse(link).success) {
		throw new CourseSyncError(
			'SOURCE_CONFIG_INVALID',
			`Invalid Dropbox shared link for ${binding.sharedLinkSecretRef}.`,
			503,
		)
	}
	return link
}

export function dropboxSyncConfigFor(binding: CourseSyncBinding) {
	return getDropboxSyncConfig({
		DROPBOX_APP_KEY: env.DROPBOX_APP_KEY,
		DROPBOX_APP_SECRET: env.DROPBOX_APP_SECRET,
		DROPBOX_OAUTH_REDIRECT_URI: env.DROPBOX_OAUTH_REDIRECT_URI,
		DROPBOX_SYNC_SHARED_FOLDER_ID: env.DROPBOX_SYNC_SHARED_FOLDER_ID,
		DROPBOX_SYNC_ALLOWED_ROOT: env.DROPBOX_SYNC_ALLOWED_ROOT,
		DROPBOX_SYNC_SHARED_LINK: sharedLinkFor(binding),
	})
}
