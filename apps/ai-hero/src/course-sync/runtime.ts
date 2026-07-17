import { env } from '@/env.mjs'
import {
	createDropboxSharedLinkAssetReader,
	getDropboxSyncConfig,
} from '@/lib/dropbox-course-sync'

import { createCourseSyncControlPlane } from './control-plane'
import { drizzleCourseSyncPersistence } from './drizzle-persistence'
import { CourseSyncError } from './errors'
import { createS3CourseSyncSnapshotStore } from './s3-snapshot-store'
import type { CourseSyncAssetReader, CourseSyncSnapshotStore } from './types'

let dropboxReader: Promise<
	Awaited<ReturnType<typeof createDropboxSharedLinkAssetReader>>
> | null = null

const assetReader: CourseSyncAssetReader = {
	async read(relativePath) {
		if (!dropboxReader) {
			const { config, missingConfig } = getDropboxSyncConfig({
				DROPBOX_APP_KEY: env.DROPBOX_APP_KEY,
				DROPBOX_APP_SECRET: env.DROPBOX_APP_SECRET,
				DROPBOX_OAUTH_REDIRECT_URI: env.DROPBOX_OAUTH_REDIRECT_URI,
				DROPBOX_SYNC_SHARED_FOLDER_ID: env.DROPBOX_SYNC_SHARED_FOLDER_ID,
				DROPBOX_SYNC_ALLOWED_ROOT: env.DROPBOX_SYNC_ALLOWED_ROOT,
				DROPBOX_SYNC_SHARED_LINK: env.DROPBOX_SYNC_SHARED_LINK,
			})
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
			dropboxReader = createDropboxSharedLinkAssetReader({
				config,
				refreshToken: env.DROPBOX_REFRESH_TOKEN,
			})
		}
		return (await dropboxReader).read(relativePath)
	},
}

let configuredSnapshotStore: CourseSyncSnapshotStore | null = null
function snapshotStore(): CourseSyncSnapshotStore {
	if (configuredSnapshotStore) return configuredSnapshotStore
	if (
		!env.COURSE_SYNC_SNAPSHOT_BUCKET ||
		!env.AWS_REGION ||
		!env.AWS_ACCESS_KEY_ID ||
		!env.AWS_SECRET_ACCESS_KEY
	) {
		throw new CourseSyncError(
			'COURSE_SYNC_SNAPSHOT_STORE_NOT_CONFIGURED',
			'Course sync immutable snapshot storage is not configured.',
			503,
		)
	}
	configuredSnapshotStore = createS3CourseSyncSnapshotStore({
		bucket: env.COURSE_SYNC_SNAPSHOT_BUCKET,
		region: env.AWS_REGION,
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	})
	return configuredSnapshotStore
}

const lazySnapshotStore: CourseSyncSnapshotStore = {
	putManifest(input) {
		return snapshotStore().putManifest(input)
	},
	putAsset(input) {
		return snapshotStore().putAsset(input)
	},
}

export const courseSyncControlPlane = createCourseSyncControlPlane({
	persistence: drizzleCourseSyncPersistence,
	assetReader,
	snapshotStore: lazySnapshotStore,
	createdById: 'course-sync-worker',
})
