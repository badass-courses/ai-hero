import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'

export type IntegrationTokenProvider = 'dropbox' | 'youtube_analytics'
export type EncryptedIntegrationToken = {
	ciphertext: string
	iv: string
	authTag: string
	keyVersion: number
	fingerprint: string
}

export function integrationTokenKey(value: string): Buffer {
	const key = Buffer.from(value, 'base64')
	if (key.length !== 32 || key.toString('base64') !== value) {
		throw new Error('INTEGRATION_TOKEN_KEY must be 32 bytes encoded as base64')
	}
	return key
}

export function encryptIntegrationToken(
	provider: IntegrationTokenProvider,
	token: string,
	key: Buffer,
): EncryptedIntegrationToken {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(Buffer.from(provider))
	return {
		ciphertext: Buffer.concat([
			cipher.update(token, 'utf8'),
			cipher.final(),
		]).toString('base64'),
		iv: iv.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64'),
		keyVersion: 1,
		fingerprint: createHash('sha256').update(token).digest('hex').slice(0, 12),
	}
}

export function decryptIntegrationToken(
	provider: IntegrationTokenProvider,
	row: EncryptedIntegrationToken,
	key: Buffer,
): string {
	if (row.keyVersion !== 1)
		throw new Error('Unsupported integration token key version')
	const iv = Buffer.from(row.iv, 'base64')
	const tag = Buffer.from(row.authTag, 'base64')
	if (iv.length !== 12 || tag.length !== 16)
		throw new Error('Invalid integration token envelope')
	const decipher = createDecipheriv('aes-256-gcm', key, iv)
	decipher.setAAD(Buffer.from(provider))
	decipher.setAuthTag(tag)
	return Buffer.concat([
		decipher.update(Buffer.from(row.ciphertext, 'base64')),
		decipher.final(),
	]).toString('utf8')
}
