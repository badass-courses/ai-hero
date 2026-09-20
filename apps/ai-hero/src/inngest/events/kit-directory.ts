export const KIT_DIRECTORY_INGEST_EVENT = 'kit/directory.ingest' as const

export type KitDirectorySubscriber = {
	id: string
	email?: string
	name?: string
	createdAt?: string
	state?: string
}

export type KitDirectoryIngest = {
	name: typeof KIT_DIRECTORY_INGEST_EVENT
	data: {
		batch: KitDirectorySubscriber[]
		/** The Kit API end_cursor after the source page, for resume receipts. */
		cursor?: string
		dryRun?: boolean
	}
}
