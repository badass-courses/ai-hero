import { env } from '@/env.mjs'
import { getDropboxSyncConfig } from '@/lib/dropbox-course-sync'

import { createCourseSyncControlPlane } from './control-plane'
import { createDropboxMuxSourceResolver } from './dropbox-mux-source'
import { drizzleCourseSyncPersistence } from './drizzle-persistence'
import { CourseSyncError } from './errors'
import { createCourseSyncMuxClient } from './mux-client'

const { config: dropboxConfig, missingConfig } = getDropboxSyncConfig({
	DROPBOX_APP_KEY: env.DROPBOX_APP_KEY,
	DROPBOX_APP_SECRET: env.DROPBOX_APP_SECRET,
	DROPBOX_OAUTH_REDIRECT_URI: env.DROPBOX_OAUTH_REDIRECT_URI,
	DROPBOX_SYNC_SHARED_FOLDER_ID: env.DROPBOX_SYNC_SHARED_FOLDER_ID,
	DROPBOX_SYNC_ALLOWED_ROOT: env.DROPBOX_SYNC_ALLOWED_ROOT,
	DROPBOX_SYNC_SHARED_LINK: env.DROPBOX_SYNC_SHARED_LINK,
})

let configuredResolver: ReturnType<typeof createDropboxMuxSourceResolver> | null = null
const muxSourceResolver = {
	async resolve(input: {
		bindingId: string
		courseVersionId: string
		sourceVideoId: string
		relativePath: string
	}) {
		if (!dropboxConfig || !env.DROPBOX_REFRESH_TOKEN) {
			throw new CourseSyncError(
				'DROPBOX_SYNC_NOT_CONFIGURED',
				`Dropbox sync is not configured: ${[
					...missingConfig,
					...(!env.DROPBOX_REFRESH_TOKEN ? ['DROPBOX_REFRESH_TOKEN'] : []),
				].join(', ')}`,
				503,
			)
		}
		if (!env.NEXTAUTH_SECRET) {
			throw new CourseSyncError(
				'COURSE_SYNC_PROXY_SIGNING_NOT_CONFIGURED',
				'Course-sync proxy signing is not configured.',
				503,
			)
		}
		configuredResolver ??= createDropboxMuxSourceResolver({
			config: dropboxConfig,
			refreshToken: env.DROPBOX_REFRESH_TOKEN,
			baseUrl: env.NEXT_PUBLIC_URL,
			signingSecret: env.NEXTAUTH_SECRET,
		})
		return configuredResolver.resolve(input)
	},
}

export const courseSyncControlPlane = createCourseSyncControlPlane({
	persistence: drizzleCourseSyncPersistence,
	muxSourceResolver,
	muxClient: createCourseSyncMuxClient({
		accessTokenId: env.MUX_ACCESS_TOKEN_ID,
		secretKey: env.MUX_SECRET_KEY,
	}),
	createdById: 'course-sync-worker',
})
