import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
	buildCompSeatPlan,
	compSeatError,
	compSeatReceipt,
	executeCompSeatPlan,
} from '@/lib/comp-seat'

export function parseCompSeatArgs(argv: string[]) {
	const values: Record<string, string> = {}
	let execute = false
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]!
		if (flag === '--execute') {
			execute = true
			continue
		}
		if (flag === '--dry-run') continue
		if (
			!['--product-id', '--user-ids', '--reason', '--plan-hash'].includes(
				flag,
			) ||
			values[flag] !== undefined ||
			!argv[index + 1] ||
			argv[index + 1]!.startsWith('--')
		)
			throw compSeatError(
				'InvalidArguments',
				'parsed the command',
				'an argument is unknown, repeated or missing its value',
				'use --product-id <id> --user-ids <file> --reason <reason> [--execute --plan-hash <hash>]',
			)
		values[flag] = argv[++index]!
	}
	if (
		!values['--product-id'] ||
		!values['--user-ids'] ||
		!values['--reason']?.trim()
	)
		throw compSeatError(
			'InvalidArguments',
			'parsed the command',
			'required arguments are missing',
			'provide --product-id, --user-ids and --reason',
		)
	if (execute && !/^[a-f0-9]{64}$/.test(values['--plan-hash'] ?? ''))
		throw compSeatError(
			'PlanMismatch',
			'executed a grant',
			'the reviewed plan hash is missing or malformed',
			'dry-run first and pass --plan-hash <hash>',
		)
	if (execute && argv.includes('--dry-run'))
		throw compSeatError(
			'InvalidArguments',
			'parsed the command',
			'--execute and --dry-run conflict',
			'choose one mode',
		)
	return {
		productId: values['--product-id']!,
		userIdsFile: values['--user-ids']!,
		reason: values['--reason']!,
		planHash: values['--plan-hash'],
		execute,
	}
}

/** A newline-delimited file of ids, not an export of customer records. */
export function parseCompSeatUserIds(text: string): string[] {
	const ids = [
		...new Set(
			text
				.split(/\r?\n/)
				.map((id) => id.trim())
				.filter(Boolean),
		),
	].sort()
	if (!ids.length || ids.some((id) => !/^[a-zA-Z0-9_-]{1,255}$/.test(id)))
		throw compSeatError(
			'InvalidUserIds',
			'read the user file',
			'it is empty or contains something other than ids',
			'use one user id per line without names or email addresses',
		)
	return ids
}

async function main() {
	if (process.argv.includes('--help')) {
		console.log(
			'pnpm comp-seat:operator --product-id <id> --user-ids <file> --reason <reason> [--execute --plan-hash <dry-run-hash>]',
		)
		return
	}
	let close: (() => Promise<void>) | undefined
	try {
		const args = parseCompSeatArgs(process.argv.slice(2))
		const userIds = parseCompSeatUserIds(readFileSync(args.userIdsFile, 'utf8'))
		const { createCompSeatRepository } =
			await import('@/lib/comp-seat-repository')
		const { closeDatabasePool } = await import('@/db')
		close = closeDatabasePool
		const repository = createCompSeatRepository()
		const plan = await buildCompSeatPlan(
			repository,
			args.productId,
			userIds,
			args.reason,
		)
		const receipt = args.execute
			? await executeCompSeatPlan(repository, plan, args.planHash)
			: compSeatReceipt(plan)
		console.log(JSON.stringify(receipt, null, 2))
		if (
			receipt.counts.failed ||
			receipt.users.some((user) => user.discord === 'delivery_failed')
		)
			process.exitCode = 1
	} catch (error) {
		// Never print driver errors, paths, SQL, connection strings or records.
		const message =
			error instanceof Error &&
			/^[A-Za-z]+: you .* Accepted: .* Fix: .* Debug:/.test(error.message)
				? error.message
				: compSeatError(
						'GrantFailed',
						'ran the comp-seat command',
						'input loading or database access failed',
						'check the ids-only file and operator environment, then dry-run again',
					).message
		console.log(
			JSON.stringify({
				version: 1,
				mode: 'error',
				counts: { created: 0 },
				users: [],
				error: message,
			}),
		)
		process.exitCode = 1
	} finally {
		await close?.()
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	void main()
