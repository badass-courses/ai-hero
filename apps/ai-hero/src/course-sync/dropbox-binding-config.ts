import { env } from '@/env.mjs'
import { getDropboxSyncConfig } from '@/lib/dropbox-course-sync'

import type { CourseSyncBinding } from './types'

/** Keep each environment access static so Next includes both optional links. */
export function sharedLinkFor(binding: CourseSyncBinding): string | undefined {
	switch (binding.sharedLinkSecretRef) {
		case 'DROPBOX_SYNC_SHARED_LINK':
			return env.DROPBOX_SYNC_SHARED_LINK
		case 'DROPBOX_SYNC_SHARED_LINK_COHORT_005':
			return env.DROPBOX_SYNC_SHARED_LINK_COHORT_005
		default: {
			const unreachable: never = binding
			return unreachable
		}
	}
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
