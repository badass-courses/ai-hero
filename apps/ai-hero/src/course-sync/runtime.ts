import { env } from '@/env.mjs'
import { getIntegrationRefreshToken } from '@/lib/integration-token-store'

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
	let resolver: ReturnType<typeof createDropboxMuxSourceResolver> | undefined
	return {
		async resolve(input) {
			if (resolver) return resolver.resolve(input)
			const { config, missingConfig } = dropboxSyncConfigFor(binding)
			const refreshToken = await getIntegrationRefreshToken('dropbox')
			if (!config || !refreshToken) {
				throw new CourseSyncError(
					'DROPBOX_SYNC_NOT_CONFIGURED',
					`Dropbox sync is not configured: ${[
						...missingConfig,
						...(!refreshToken ? ['Dropbox not connected (no DB token row)'] : []),
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
			resolver = createDropboxMuxSourceResolver({
				config,
				refreshToken,
				baseUrl: env.NEXT_PUBLIC_URL,
				signingSecret: env.NEXTAUTH_SECRET,
			})
			return resolver.resolve(input)
		},
	}
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
