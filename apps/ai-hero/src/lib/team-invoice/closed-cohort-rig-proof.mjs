// Run only against an already-started local commerce rig. Never load app .env files.
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const slot = process.argv[2] ?? '0'
const engine = process.argv[3] === '--engine'
if (!/^[0-9]$/.test(slot)) throw new Error('Expected a rig slot from 0 to 9')
if (process.argv.length > 4 || (process.argv[3] && !engine))
	throw new Error('Usage: closed-cohort-rig-proof.mjs [slot] [--engine]')
const app = fileURLToPath(new URL('../../../', import.meta.url))
const path = resolve(
	app,
	`scripts/commerce-rig/.state/slot-${slot}/runtime.env`,
)
const info = await stat(path)
if (!info.isFile() || (info.mode & 0o077) !== 0) {
	throw new Error('Rig runtime env must be a private regular file')
}
const runtime = Object.fromEntries(
	(await readFile(path, 'utf8'))
		.split('\n')
		.filter((line) => line.includes('='))
		.map((line) => {
			const at = line.indexOf('=')
			return [line.slice(0, at), line.slice(at + 1)]
		}),
)
if (!/^(sk|rk)_test_/.test(runtime.STRIPE_SECRET_TOKEN ?? '')) {
	throw new Error('Refusing anything but a Stripe test key')
}
if (!runtime.DATABASE_URL) throw new Error('Missing rig database URL')
const database = new URL(runtime.DATABASE_URL)
if (
	database.protocol !== 'mysql:' ||
	database.hostname !== '127.0.0.1' ||
	database.port !== String(13316 + Number(slot) * 10) ||
	database.pathname !== '/commerce_rig'
) {
	throw new Error('Refusing a database outside the selected commerce rig')
}
if (
	engine &&
	(runtime.FRONT_DESK_URL !== `http://127.0.0.1:${3311 + Number(slot) * 10}` ||
		!runtime.FRONT_DESK_PRICING_TOKEN ||
		!runtime.FRONT_DESK_QUOTES_TOKEN)
)
	throw new Error('Engine proof requires the selected rig front desk stub')
database.pathname = '/mysql'
// The suite's guard needs the server's root login to create its own database.
// This is the rig's disposable loopback container, whose fixed local-only root
// password the rig itself uses (`rig reset`).
database.username = 'root'
database.password = 'root-local-only'
// The suite creates/drops only its UUID-named database on this rig server.
// It consumes Stripe's real payment event through the real invoice handler,
// then redeems a seat and invokes the shared post-purchase grant function.
// This is not a proof of HTTP webhook forwarding or Inngest job scheduling.
const child = spawnSync(
	'pnpm',
	[
		'exec',
		'vitest',
		'run',
		'-c',
		'vitest.config.ts',
		'src/lib/team-invoice/team-invoice-form.sandbox.mysql.test.ts',
		'-t',
		'cohort',
	],
	{
		cwd: app,
		stdio: 'inherit',
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
			NODE_ENV: 'test',
			AIH_TEST_MYSQL_SERVER_URL: database.toString(),
			AIH_STRIPE_SANDBOX_KEY: runtime.STRIPE_SECRET_TOKEN,
			AIH_TEAM_INVOICE_ENGINE: engine ? '1' : '0',
			...(engine
				? {
						AIH_RIG_FRONT_DESK_URL: runtime.FRONT_DESK_URL,
						AIH_RIG_FRONT_DESK_PRICING_TOKEN: runtime.FRONT_DESK_PRICING_TOKEN,
						AIH_RIG_FRONT_DESK_QUOTES_TOKEN: runtime.FRONT_DESK_QUOTES_TOKEN,
					}
				: {}),
		},
	},
)
if (child.error) throw child.error
process.exitCode = child.status ?? 1
