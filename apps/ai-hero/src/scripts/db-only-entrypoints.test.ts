import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const appRoot = process.cwd()
const discordSource = readFileSync(path.join(appRoot, 'scripts/backfill-discord-legend-role.mts'), 'utf8')

// Evaluate only configuration declarations, never the script's executable body.
// In particular this does not import/launch the Discord script or its DB client.
const configPrefix = ts.transpileModule(
	discordSource.slice(0, discordSource.indexOf('const client =')),
	{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText
	.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '')
	.replace(/^export \{\};?\s*$/gm, '')

const configEnv = {
	DATABASE_URL: 'mysql://test:test@localhost:1/mock_only',
	DISCORD_BOT_TOKEN: 'mock-token',
	DISCORD_GUILD_ID: 'mock-guild',
}

function readDiscordConfig(env: Record<string, string | undefined>) {
	const filesystem = new Proxy({}, { get: () => { throw new Error('filesystem touched') } })
	return vm.runInNewContext(`${configPrefix}\n;({ databaseUrl, discordBotToken, discordGuildId })`, {
		process: { env }, fs: filesystem, path: filesystem,
	})
}

describe('Discord ambient configuration', () => {
	it.each(Object.keys(configEnv))('names missing %s before any IO', (name) => {
		const env = { ...configEnv, [name]: undefined }
		expect(() => readDiscordConfig(env)).toThrow(`Missing required environment variable: ${name}`)
	})
	it('reads ambient values without opening env files', () => {
		expect(readDiscordConfig(configEnv)).toEqual({
			databaseUrl: configEnv.DATABASE_URL,
			discordBotToken: configEnv.DISCORD_BOT_TOKEN,
			discordGuildId: configEnv.DISCORD_GUILD_ID,
		})
		expect(discordSource).not.toMatch(/ENV_CANDIDATES|loadEnvFile|readFileSync|existsSync|\.env\./)
	})
})

// Traverse the real local runtime import graph without executing an ops entrypoint.
// Package imports are leaves; type-only imports cannot evaluate app modules.
function localRuntimeGraph(entry: string, seen = new Set<string>()): Set<string> {
	if (seen.has(entry)) return seen
	seen.add(entry)
	const source = ts.createSourceFile(entry, readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true)
	const specifiers: string[] = []
	function visit(node: ts.Node) {
		if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
			(ts.isExportDeclaration(node) && !node.isTypeOnly)) {
			if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				specifiers.push(node.moduleSpecifier.text)
			}
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
			specifiers.push(node.arguments[0].text)
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	for (const specifier of specifiers) {
		const base = specifier.startsWith('@/') ? path.join(appRoot, 'src', specifier.slice(2))
			: specifier.startsWith('.') ? path.resolve(path.dirname(entry), specifier) : undefined
		if (!base) continue
		const file = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, path.join(base, 'index.ts')].find((candidate) => existsSync(candidate) && /\.(?:ts|tsx|mjs|mts)$/.test(candidate))
		if (!file) throw new Error(`Unresolved local dependency: ${specifier}`)
		localRuntimeGraph(file, seen)
	}
	return seen
}

it('PPP reaches the shared client and constants, not app env or commerce composition', () => {
	const graph = [...localRuntimeGraph(path.join(appRoot, 'scripts/backfill-crash-course-ppp-alumni-entitlements.ts'))]
		.map((file) => path.relative(appRoot, file))
	expect(graph).toContain('src/db/client.ts')
	expect(graph).toContain('src/lib/entitlement-source-type.ts')
	expect(graph).not.toContain('src/db/index.ts')
	expect(graph).not.toContain('src/env.mjs')
	expect(graph).not.toContain('src/coursebuilder/stripe-provider.ts')
	expect(graph).not.toContain('src/lib/entitlements.ts')
})
