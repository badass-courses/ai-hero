import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'

export type RunIdentity = {
	vercelEnv: string | null
	nodeEnv: string | null
	onVercel: boolean
	inngest: 'dev' | 'cloud'
	hostname: string
	gitSha: string | null
	dbHost: string | null
	dbUsername: string | null
}

/** Pure projection: never retain the URL, password, path or query, even on error. */
export function buildRunIdentity(
	env: Record<string, string | undefined>,
	runtime: { hostname: string; gitSha?: string | null; inngestDev?: boolean },
): RunIdentity {
	let dbHost: string | null = null
	let dbUsername: string | null = null
	try {
		const url = new URL(env.DATABASE_URL ?? '')
		if (url.protocol === 'mysql:' || url.protocol === 'mysql2:') {
			dbHost = url.hostname || null
			dbUsername = url.username || null
		}
	} catch {
		// URL errors can contain credentials. Never log or return the error.
	}
	return {
		vercelEnv: env.VERCEL_ENV ?? null,
		nodeEnv: env.NODE_ENV ?? null,
		onVercel: env.VERCEL === '1',
		inngest:
			(runtime.inngestDev ??
			(env.INNGEST_DEV === '1' || env.INNGEST_DEV === 'true'))
				? 'dev'
				: 'cloud',
		hostname: runtime.hostname,
		gitSha: env.VERCEL_GIT_COMMIT_SHA ?? runtime.gitSha ?? null,
		dbHost,
		dbUsername,
	}
}

let localGitSha: string | null | undefined
function readLocalGitSha(): string | null {
	if (localGitSha !== undefined) return localGitSha
	try {
		// No shell, network, or writes. Bound the one local lookup per process.
		const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
			timeout: 100,
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8',
		}).trim()
		localGitSha = /^[a-f0-9]{40,64}$/.test(sha) ? sha : null
	} catch {
		localGitSha = null
	}
	return localGitSha
}

// The SDK exposes no public mode accessor. Keep this optional, guarded probe
// in one place; missing/changing SDK internals fall back to INNGEST_DEV.
let isInngestDev: () => boolean | undefined = () => undefined
export function registerInngestRunIdentity(client: object): void {
	isInngestDev = () => {
		try {
			const mode = Reflect.get(client, 'mode')?.isDev
			return typeof mode === 'boolean' ? mode : undefined
		} catch {
			return undefined
		}
	}
}

export function getRunIdentity(inngestDev = isInngestDev()): RunIdentity {
	return buildRunIdentity(process.env, {
		hostname: hostname(),
		gitSha: process.env.VERCEL_GIT_COMMIT_SHA ? null : readLocalGitSha(),
		inngestDev,
	})
}

/** All Vercel environments share this database. This is a warning, not a gate. */
export function isNonProdExecutorOnProdDb(identity: RunIdentity): boolean {
	return Boolean(
		identity.dbHost?.toLowerCase().endsWith('.psdb.cloud') &&
		!(identity.onVercel && identity.vercelEnv === 'production'),
	)
}
