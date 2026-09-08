import { createHash } from 'node:crypto'
import { z } from 'zod'

// pscale JSON marshals DatabaseBranchPassword, not its human/CSV wrapper.
// Source: planetscale/cli cf7e2942, internal/planetscale/passwords.go and
// internal/cmd/password/password.go (MarshalJSON). No provider API call here.
const passwordRecord = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		username: z.string().min(1),
		access_host_url: z.string().min(1),
		role: z.enum(['reader', 'writer', 'readwriter', 'admin']),
		database_branch: z.object({ name: z.string().min(1) }).passthrough(),
		created_at: z.string().datetime(),
		expires_at: z.string().datetime().nullable(),
		deleted_at: z.string().datetime().nullable(),
		ttl_seconds: z.number().int().min(0),
		replica: z.boolean(),
		plain_text: z.string().optional(),
	})
	.passthrough()
const receiptSchema = z
	.object({
		version: z.literal(1),
		provider: z.literal('planetscale'),
		purpose: z.literal('contact-integrity-maintenance'),
		operatorRole: z.enum(['reader', 'writer']),
		target: z.string(),
		approvalRef: z.string(),
		organization: z.string().min(1),
		database: z.string().min(1),
		branch: z.string().min(1),
		credentialName: z.string().min(1),
		readbackAt: z.string().datetime(),
		validUntil: z.string().datetime(),
		creation: passwordRecord,
		readback: passwordRecord,
	})
	.strict()
export const operatorCredentialsSchema = z
	.object({
		purpose: z.literal('contact-integrity-maintenance'),
		target: z.string(),
		host: z.string().min(1).max(253),
		port: z.number().int().min(1).max(65535),
		database: z.string().regex(/^[A-Za-z0-9_]+$/),
		user: z.string().min(1).max(255),
		password: z.string().min(1),
		tls: z.boolean(),
		ca: z.string().optional(),
		provider: z.literal('planetscale').optional(),
		organization: z.string().optional(),
		branch: z.string().optional(),
		operatorRole: z.enum(['reader', 'writer']).optional(),
	})
	.strict()
export type OperatorCredentials = z.infer<typeof operatorCredentialsSchema>
const unset = (value: string | null) =>
	value === null || value === '0001-01-01T00:00:00Z'
/** Checks an operator-approved private artifact pinned independently in the
 * approval packet. Hash/shape agreement is not API authentication, signature
 * validation, live revocation proof or a grant of operator approval. */
export function validateProviderReceipt(
	raw: string,
	expectedHash: string,
	config: OperatorCredentials,
	binding: { target: string; approvalRef: string; mode: string; maxMs: number },
	now = Date.now(),
) {
	if (
		!/^[a-f0-9]{64}$/.test(expectedHash) ||
		createHash('sha256').update(raw).digest('hex') !== expectedHash
	)
		throw new Error('Receipt pin mismatch')
	const r = receiptSchema.parse(JSON.parse(raw)),
		role = binding.mode === 'apply' ? 'writer' : 'reader'
	if (
		config.provider !== 'planetscale' ||
		!config.tls ||
		config.port !== 3306 ||
		config.operatorRole !== role ||
		r.operatorRole !== role ||
		r.target !== binding.target ||
		config.target !== r.target ||
		r.approvalRef !== binding.approvalRef ||
		r.organization !== config.organization ||
		r.database !== config.database ||
		r.branch !== config.branch
	)
		throw new Error('Receipt scope mismatch')
	if (
		Date.parse(r.readbackAt) > now ||
		Date.parse(r.validUntil) <= now + binding.maxMs ||
		Date.parse(r.validUntil) <= Date.parse(r.readbackAt)
	)
		throw new Error('Receipt expired')
	const expectedRole = role === 'writer' ? 'readwriter' : 'reader'
	for (const p of [r.creation, r.readback]) {
		if (
			p.name !== r.credentialName ||
			p.username !== config.user ||
			p.access_host_url !== config.host ||
			p.database_branch.name !== r.branch ||
			p.role !== expectedRole ||
			p.replica ||
			!unset(p.deleted_at) ||
			Date.parse(p.created_at) > Date.parse(r.readbackAt)
		)
			throw new Error('Provider password mismatch')
		if (
			!unset(p.expires_at) &&
			Date.parse(p.expires_at!) <= now + binding.maxMs
		)
			throw new Error('Provider password expired')
		if (p.ttl_seconds > 0 && unset(p.expires_at))
			throw new Error('Missing provider expiry')
	}
	if (
		r.creation.id !== r.readback.id ||
		r.creation.created_at !== r.readback.created_at ||
		r.creation.plain_text !== config.password ||
		(r.readback.plain_text && r.readback.plain_text !== config.password)
	)
		throw new Error('Credential readback mismatch')
	return {
		scope: [
			r.provider,
			r.organization,
			r.database,
			r.branch,
			r.readback.id,
			r.operatorRole,
		],
		validUntil: Math.min(
			Date.parse(r.validUntil),
			...[r.creation, r.readback]
				.filter((p) => !unset(p.expires_at))
				.map((p) => Date.parse(p.expires_at!)),
		),
	}
}
