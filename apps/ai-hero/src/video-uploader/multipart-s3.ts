import {
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	S3Client,
	S3ClientConfig,
	UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { v4 as uuidv4 } from 'uuid'

const options: S3ClientConfig = {
	region: process.env.AWS_VIDEO_UPLOAD_REGION,
	credentials: {
		accessKeyId: process.env.AWS_VIDEO_UPLOAD_ACCESS_KEY_ID!,
		secretAccessKey: process.env.AWS_VIDEO_UPLOAD_SECRET_ACCESS_KEY!,
	},
}

const client = new S3Client(options)

function getBucket() {
	return process.env.AWS_VIDEO_UPLOAD_BUCKET!
}

function buildKey(filename: string) {
	const folder = process.env.AWS_VIDEO_UPLOAD_FOLDER || 'partner-uploads'
	return `${folder}/${uuidv4()}/${filename}`
}

/**
 * Initiate a multipart upload and return the uploadId + key.
 */
export async function createMultipartUpload(options: { filename: string }) {
	const Key = buildKey(options.filename)
	const Bucket = getBucket()

	const command = new CreateMultipartUploadCommand({
		Bucket,
		Key,
		ContentType: 'application/octet-stream',
	})

	const response = await client.send(command)

	if (!response.UploadId) {
		throw new Error('Failed to create multipart upload')
	}

	return {
		uploadId: response.UploadId,
		key: Key,
		publicUrl: `https://${Bucket}.s3.${process.env.AWS_VIDEO_UPLOAD_REGION}.amazonaws.com/${Key}`,
	}
}

/**
 * Generate a presigned URL for uploading a single part.
 */
export async function getMultipartPartUrl(options: {
	key: string
	uploadId: string
	partNumber: number
}) {
	const Bucket = getBucket()

	const command = new UploadPartCommand({
		Bucket,
		Key: options.key,
		UploadId: options.uploadId,
		PartNumber: options.partNumber,
	})

	const signedUrl = await getSignedUrl(client, command, { expiresIn: 3600 })

	return { signedUrl, partNumber: options.partNumber }
}

/**
 * Complete a multipart upload after all parts are uploaded.
 */
export async function completeMultipartUpload(options: {
	key: string
	uploadId: string
	parts: Array<{ partNumber: number; etag: string }>
}) {
	const Bucket = getBucket()

	const command = new CompleteMultipartUploadCommand({
		Bucket,
		Key: options.key,
		UploadId: options.uploadId,
		MultipartUpload: {
			Parts: options.parts
				.sort((a, b) => a.partNumber - b.partNumber)
				.map((part) => ({
					PartNumber: part.partNumber,
					ETag: part.etag,
				})),
		},
	})

	const response = await client.send(command)

	return {
		publicUrl:
			response.Location ||
			`https://${Bucket}.s3.${process.env.AWS_VIDEO_UPLOAD_REGION}.amazonaws.com/${options.key}`,
		key: options.key,
	}
}
