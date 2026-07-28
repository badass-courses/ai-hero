import { Readable } from 'node:stream'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { CourseSyncError } from './errors'
import type { CourseSyncSnapshotStore } from './types'

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader()
	for (;;) {
		const chunk = await reader.read()
		if (chunk.done) return
		yield chunk.value
	}
}

export function createS3CourseSyncSnapshotStore(input: {
	bucket: string
	region: string
	accessKeyId: string
	secretAccessKey: string
	client?: S3Client
}): CourseSyncSnapshotStore {
	const client =
		input.client ??
		new S3Client({
			region: input.region,
			credentials: {
				accessKeyId: input.accessKeyId,
				secretAccessKey: input.secretAccessKey,
			},
		})
	const put = async (args: {
		key: string
		body: Uint8Array | Readable
		bytes: number
		contentType: string
		sha256: string
	}) => {
		const key = `course-sync/${args.key}`
		try {
			await client.send(
				new PutObjectCommand({
					Bucket: input.bucket,
					Key: key,
					Body: args.body,
					ContentLength: args.bytes,
					ContentType: args.contentType,
					ChecksumSHA256: Buffer.from(args.sha256, 'hex').toString('base64'),
					IfNoneMatch: '*',
					Metadata: { sha256: args.sha256, immutable: 'true' },
					ServerSideEncryption: 'AES256',
				}),
			)
		} catch (error) {
			const status = (error as { $metadata?: { httpStatusCode?: number } })
				.$metadata?.httpStatusCode
			if (status !== 412) {
				throw new CourseSyncError(
					'SNAPSHOT_WRITE_FAILED',
					error instanceof Error
						? error.message
						: 'Immutable snapshot write failed.',
					500,
				)
			}
		}
		return `s3://${input.bucket}/${key}`
	}
	return {
		putManifest({ key, bytes, sha256 }) {
			return put({
				key,
				body: bytes,
				bytes: bytes.byteLength,
				contentType: 'application/json',
				sha256,
			})
		},
		putAsset({ key, stream, bytes, sha256 }) {
			return put({
				key,
				body: Readable.from(streamChunks(stream)),
				bytes,
				contentType: 'video/mp4',
				sha256,
			})
		},
	}
}
