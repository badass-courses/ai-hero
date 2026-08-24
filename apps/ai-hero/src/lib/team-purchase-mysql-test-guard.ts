import { randomUUID } from 'node:crypto'

export type MySqlIntegrationEnvironment = {
	nodeEnv: string | undefined
	vercelEnv: string | undefined
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function validateMySqlIntegrationServerUrl(
	rawUrl: string,
	environment: MySqlIntegrationEnvironment = {
		nodeEnv: process.env.NODE_ENV,
		vercelEnv: process.env.VERCEL_ENV,
	},
): URL {
	if (
		environment.nodeEnv === 'production' ||
		environment.vercelEnv === 'production'
	) {
		throw new Error('unsafe-team-fulfillment-mysql-test-environment')
	}

	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		throw new Error('unsafe-team-fulfillment-mysql-test-url')
	}
	const port = Number(url.port)
	if (
		url.protocol !== 'mysql:' ||
		!LOOPBACK_HOSTS.has(url.hostname) ||
		url.username !== 'root' ||
		!url.password ||
		!Number.isInteger(port) ||
		port <= 1024 ||
		port > 65535 ||
		port === 3306 ||
		url.pathname !== '/mysql' ||
		url.search ||
		url.hash
	) {
		throw new Error('unsafe-team-fulfillment-mysql-test-url')
	}
	return url
}

export async function connectToDisposableMySqlServer<T>(
	rawUrl: string,
	environment: MySqlIntegrationEnvironment,
	connect: (safeServerUrl: URL) => T | Promise<T>,
): Promise<T> {
	const safeServerUrl = validateMySqlIntegrationServerUrl(rawUrl, environment)
	return connect(safeServerUrl)
}

export function createDisposableDatabaseName(): string {
	return `aih_team_fulfillment_test_${randomUUID().replaceAll('-', '')}`
}
