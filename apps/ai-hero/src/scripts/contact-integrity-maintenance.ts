import {
	readFileSync,
	readSync,
	writeFileSync,
	openSync,
	closeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Effect } from 'effect'
import { z } from 'zod'
import { assertEmailKeyRuntime } from '../lib/subscriber-marketing/contact-email-equivalence'
import {
	maintainContactIntegrity,
	publicMaintenanceResult,
	maintenanceOptionsSchema,
	type MaintenanceConnection,
} from '../lib/subscriber-marketing/contact-integrity-maintenance'

const credentialsSchema = z
	.object({
		purpose: z.literal('contact-integrity-maintenance'),
		target: z.string(),
		host: z.string().min(1).max(253),
		port: z.number().int().min(1).max(65535),
		database: z.string().regex(/^[A-Za-z0-9_]+$/),
		user: z.enum([
			'aih_contact_maintenance_reader',
			'aih_contact_maintenance_writer',
		]),
		password: z.string().min(1),
		tls: z.boolean(),
		ca: z.string().optional(),
	})
	.strict()
const stateSchema = z
	.object({
		version: z.literal(1),
		mode: z.enum(['dry-run', 'apply']),
		target: z.string(),
		scope: z.string(),
		after: z.string().max(255).optional(),
		unresolved: z.array(
			z.object({
				id: z.string(),
				reason: z.enum(['conflict', 'deleted', 'invalid-raw']),
			}),
		),
		previousState: z.string().nullable(),
	})
	.strict()
const modes = ['plan', 'inspect', 'dry-run', 'apply', 'verify'] as const
export const offlineMaintenancePlan = {
	version: 1,
	command: 'contact-integrity:maintenance',
	mode: 'plan',
	databaseOpened: false,
	approvalGranted: false,
	productionHeld: true,
	modes,
	boundary:
		'Dedicated operator credential JSON on an explicitly supplied inherited fd >= 3. Never application env, dotenv, URI or command-line credentials.',
	approval:
		'Database modes require separate actual operator approval, exact target, approval reference and --acknowledge-approval. CLI strings record assertions; they do not grant approval.',
	coverage:
		'dry-run/apply are bounded keyset pages, never whole-table certificates. verify starts a new native MySQL 8.4 consistent read-only snapshot and cannot resume; budget exhaustion cannot certify coverage. Fresh nonlocking stale read is separate.',
	state:
		'--state-in/--state-out are private linkable machine state, not anonymous. Retain every state file and unresolved row list. New state files are exclusive 0600; no overwrite.',
	example: 'pnpm contact-integrity:maintenance --mode plan',
} as const

/** Injectable connector is a test seam. The default connector is imported only
 * after all gates. No module imports the application database or dotenv. */
export async function runMaintenanceCli(
	args: string[],
	dependencies: {
		connect?: (
			config: z.infer<typeof credentialsSchema>,
		) => Promise<MaintenanceConnection>
		readCredential?: (fd: number) => string
	} = {},
) {
	try {
		if (args.length === 0 || args.includes('--help'))
			return { exitCode: 0, output: offlineMaintenancePlan }
		const flags = new Map<string, string>()
		for (let i = 0; i < args.length; i++) {
			const key = args[i]!
			if (flags.has(key)) throw new Error('Duplicate flag')
			if (key === '--acknowledge-approval') {
				flags.set(key, 'true')
				continue
			}
			if (
				![
					'--mode',
					'--target',
					'--approval-ref',
					'--credential-fd',
					'--page-size',
					'--max-rows',
					'--max-writes',
					'--max-ms',
					'--state-in',
					'--state-out',
				].includes(key)
			)
				throw new Error('Unknown flag')
			const value = args[++i]
			if (value === undefined || value.startsWith('--'))
				throw new Error('Missing flag')
			flags.set(key, value)
		}
		const mode = flags.get('--mode') ?? 'plan'
		if (mode === 'plan') return { exitCode: 0, output: offlineMaintenancePlan }
		if (!modes.includes(mode as (typeof modes)[number]))
			throw new Error('Invalid mode')
		const target = flags.get('--target'),
			approval = flags.get('--approval-ref'),
			fd = Number(flags.get('--credential-fd'))
		if (
			!target ||
			!/^[a-z][a-z0-9-]{0,63}$/.test(target) ||
			!approval ||
			!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(approval) ||
			flags.get('--acknowledge-approval') !== 'true' ||
			!Number.isInteger(fd) ||
			fd < 3 ||
			fd > 1024
		)
			throw new Error('Approval/target/credential boundary missing')
		if ((mode === 'apply' || mode === 'dry-run') && !flags.get('--state-out'))
			throw new Error('Private state output required')
		if (
			(mode === 'verify' || mode === 'inspect') &&
			(flags.has('--state-in') || flags.has('--state-out'))
		)
			throw new Error('Snapshot cannot resume')
		assertEmailKeyRuntime()
		const options = maintenanceOptionsSchema.parse({
			mode,
			pageSize: Number(flags.get('--page-size') ?? 100),
			maxRows: Number(flags.get('--max-rows') ?? 1000),
			maxWrites: Number(flags.get('--max-writes') ?? 100),
			maxMs: Number(flags.get('--max-ms') ?? 10000),
		})
		// Bounded inherited input; a pipe should be closed by its supplying operator.
		const raw = (
			dependencies.readCredential ??
			((n) => {
				const buffer = Buffer.alloc(16385)
				let size = 0
				while (size < buffer.length) {
					const read = readSync(n, buffer, size, buffer.length - size, null)
					if (read === 0) break
					size += read
				}
				if (size > 16384) throw new Error('Credential envelope too large')
				return buffer.subarray(0, size).toString('utf8')
			})
		)(fd)
		if (Buffer.byteLength(raw) > 16384)
			throw new Error('Credential envelope too large')
		const config = credentialsSchema.parse(JSON.parse(raw))
		if (
			config.target !== target ||
			config.user !==
				(mode === 'apply'
					? 'aih_contact_maintenance_writer'
					: 'aih_contact_maintenance_reader')
		)
			throw new Error('Dedicated target/principal mismatch')
		if (!config.tls) {
			if (target !== 'disposable-ci' || process.env.CI !== 'true')
				throw new Error('TLS required')
			const { validateMySqlIntegrationServerUrl } =
				await import('../lib/team-purchase-mysql-test-guard')
			const url = new URL('mysql://127.0.0.1/mysql')
			url.hostname = config.host
			url.port = String(config.port)
			validateMySqlIntegrationServerUrl(url.toString(), {
				nodeEnv: 'test',
				vercelEnv: undefined,
			})
		}
		const scope = createHash('sha256')
			.update(
				JSON.stringify([
					config.host,
					config.port,
					config.database,
					config.user,
				]),
			)
			.digest('hex')
		const inputPath = flags.get('--state-in')
		if (inputPath) {
			const bytes = readFileSync(inputPath)
			if (bytes.length > 8_000_000) throw new Error('State too large')
			const state = stateSchema.parse(JSON.parse(bytes.toString('utf8')))
			if (
				state.mode !== mode ||
				state.target !== target ||
				state.scope !== scope
			)
				throw new Error('Cursor scope mismatch')
			options.after = state.after
		}
		// Reserve private output before connecting or writing any data. Never overwrite.
		let stateFd: number | undefined
		const out = flags.get('--state-out')
		if (out) stateFd = openSync(out, 'wx', 0o600)
		try {
			const connect =
				dependencies.connect ??
				(async (config) => {
					const mysql = await import('mysql2/promise')
					const connection = await mysql.createConnection({
						host: config.host,
						port: config.port,
						database: config.database,
						user: config.user,
						password: config.password,
						ssl: config.tls
							? {
									rejectUnauthorized: true,
									...(config.ca ? { ca: config.ca } : {}),
								}
							: undefined,
						charset: 'UTF8MB4_BIN',
						timezone: 'Z',
						connectTimeout: Math.min(options.maxMs, 10000),
						multipleStatements: false,
					})
					return {
						query: async (sql: string, values: unknown[], timeout: number) => {
							const [result] = await connection.query({ sql, values, timeout })
							return result
						},
						destroy: () => connection.destroy(),
					}
				})
			const result = await Effect.runPromise(
				maintainContactIntegrity(await connect(config), options),
			)
			if (stateFd !== undefined)
				writeFileSync(
					stateFd,
					JSON.stringify({
						version: 1,
						mode,
						target,
						scope,
						...result.privateState,
						previousState: inputPath ?? null,
					}) + '\n',
				)
			return {
				exitCode: result.code === 'complete' ? 0 : 2,
				output: {
					version: 1,
					target,
					approvalReferenceRecorded: true,
					approvalGranted: false,
					...publicMaintenanceResult(result),
				},
			}
		} finally {
			if (stateFd !== undefined) closeSync(stateFd)
		}
	} catch {
		return {
			exitCode: 2,
			output: {
				version: 1,
				code: 'maintenance-refused',
				approvalGranted: false,
				unqualifiedReady: false,
			},
		}
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const result = await runMaintenanceCli(process.argv.slice(2))
	process.stdout.write(JSON.stringify(result.output) + '\n')
	process.exitCode = result.exitCode
}
