import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { closeDatabasePool } from '@/db'
import {
	applyMemberlessTeamPurchaseRepair,
	previewMemberlessTeamPurchaseRepair,
} from '@/lib/team-purchase-memberless-repair'

export type MemberlessRepairArgs = {
	purchaseId: string
	allowWrite: boolean
	confirmCount: number | null
	approvedPlanHash: string | null
	planPath: string | null
	receiptPath: string
}

export function parseMemberlessRepairArgs(
	argv: string[],
): MemberlessRepairArgs {
	const values = new Map<string, string>()
	let allowWrite = false
	let dryRun = false
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!
		if (flag === '--allow-write' || flag === '--dry-run') {
			if (flag === '--allow-write') allowWrite = true
			else dryRun = true
			continue
		}
		if (
			![
				'--purchase-id',
				'--confirm-count',
				'--approved-plan-hash',
				'--plan',
				'--receipt',
			].includes(flag) ||
			values.has(flag)
		)
			throw new Error('Unknown or repeated repair argument')
		const value = argv[++i]
		if (!value || value.startsWith('--'))
			throw new Error(`${flag} requires a value`)
		values.set(flag, value)
	}
	if (allowWrite && dryRun)
		throw new Error('Choose dry-run or allow-write, not both')
	const purchaseId = values.get('--purchase-id')
	const receiptPath = values.get('--receipt')
	const planPath = values.get('--plan') ?? null
	const approvedPlanHash = values.get('--approved-plan-hash') ?? null
	const confirmCount = values.has('--confirm-count')
		? Number(values.get('--confirm-count'))
		: null
	if (!purchaseId || !receiptPath || !isAbsolute(receiptPath))
		throw new Error(
			'Exactly one purchase and an absolute private receipt path are required',
		)
	if (planPath && !isAbsolute(planPath))
		throw new Error('--plan requires an absolute private path')
	if (
		allowWrite &&
		(!planPath ||
			confirmCount !== 1 ||
			!approvedPlanHash?.match(/^[a-f0-9]{64}$/))
	)
		throw new Error(
			'Apply requires a preview file, count 1, and the independently approved plan hash',
		)
	if (!allowWrite && (planPath || confirmCount !== null || approvedPlanHash))
		throw new Error('Approval arguments are only valid for allow-write')
	return {
		purchaseId,
		receiptPath,
		planPath,
		approvedPlanHash,
		confirmCount,
		allowWrite,
	}
}

async function main() {
	let receipt: Awaited<ReturnType<typeof open>> | undefined
	try {
		const args = parseMemberlessRepairArgs(process.argv.slice(2))
		// Reserve before any apply. Existing receipts are never overwritten, and
		// no production change can precede a writable private receipt destination.
		receipt = await open(args.receiptPath, 'wx', 0o600)
		const startedAt = new Date().toISOString()
		const result = args.allowWrite
			? await applyMemberlessTeamPurchaseRepair(
					(
						JSON.parse(await readFile(args.planPath!, 'utf8')) as {
							result?: { plan?: unknown }
						}
					).result?.plan,
					{
						allowWrite: true,
						confirmCount: args.confirmCount!,
						purchaseId: args.purchaseId,
						approvedPlanHash: args.approvedPlanHash!,
					},
				)
			: await previewMemberlessTeamPurchaseRepair(args.purchaseId)
		await receipt.writeFile(
			`${JSON.stringify({ version: 1, task: 'memberless-team-purchase-repair', mode: args.allowWrite ? 'allow-write' : 'dry-run', startedAt, completedAt: new Date().toISOString(), result }, null, 2)}\n`,
		)
		console.log(
			JSON.stringify({
				status: result.status,
				receiptPath: args.receiptPath,
				mode: args.allowWrite ? 'allow-write' : 'dry-run',
			}),
		)
		if (result.status === 'held' || result.status === 'verification-failed')
			process.exitCode = 1
	} catch (error) {
		if (receipt)
			await receipt.writeFile(
				`${JSON.stringify({ status: 'failed', writeOutcome: 'unknown-until-independent-readback', error: error instanceof Error ? error.message : 'Repair failed', completedAt: new Date().toISOString() })}\n`,
			)
		console.error(
			'Memberless repair failed; inspect the private receipt and independently read back before retrying',
		)
		process.exitCode = 1
	} finally {
		await receipt?.close()
		await closeDatabasePool()
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	void main()
