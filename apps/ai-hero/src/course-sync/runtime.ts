import { env } from '@/env.mjs'

import { createCourseSyncControlPlane } from './control-plane'
import { dropboxSyncConfigFor } from './dropbox-binding-config'
import {
	createBindingScopedMuxSourceResolver,
	createDropboxMuxSourceResolver,
} from './dropbox-mux-source'
import { drizzleCourseSyncPersistence } from './drizzle-persistence'
import { CourseSyncError } from './errors'
import { createCourseSyncMuxClient } from './mux-client'

const muxSourceResolver = createBindingScopedMuxSourceResolver((binding) => {
	const { config, missingConfig } = dropboxSyncConfigFor(binding)
	if (!config || !env.DROPBOX_REFRESH_TOKEN) {
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
	return createDropboxMuxSourceResolver({
		config,
		refreshToken: env.DROPBOX_REFRESH_TOKEN,
		baseUrl: env.NEXT_PUBLIC_URL,
		signingSecret: env.NEXTAUTH_SECRET,
	})
})

export const courseSyncControlPlane = createCourseSyncControlPlane({
	persistence: drizzleCourseSyncPersistence,
	muxSourceResolver,
	muxClient: createCourseSyncMuxClient({
		accessTokenId: env.MUX_ACCESS_TOKEN_ID,
		secretKey: env.MUX_SECRET_KEY,
	}),
	createdById: 'course-sync-worker',
})
