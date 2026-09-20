export const KIT_DIRECTORY_INGEST_EVENT = 'kit/directory.ingest' as const

export type KitDirectorySubscriber = {
	id: string
	email?: string
	name?: string
	createdAt?: string
}

export type KitDirectoryIngest = {
	name: typeof KIT_DIRECTORY_INGEST_EVENT
	data: {
		batch: KitDirectorySubscriber[]
		/** The last Kit id in the source batch, for operator resume receipts. */
		cursor?: string
		dryRun?: boolean
	}
}
