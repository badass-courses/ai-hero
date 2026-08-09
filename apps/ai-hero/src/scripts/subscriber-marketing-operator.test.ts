import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
	new URL('./subscriber-marketing-operator.ts', import.meta.url),
	'utf8',
)

function functionSource(name: string, nextName: string) {
	const start = source.indexOf(`async function ${name}`)
	const end = source.indexOf(`async function ${nextName}`, start)
	return source.slice(start, end)
}

function commandSource(command: string, nextCommand: string) {
	const start = source.indexOf(`command === '${command}'`)
	const end = source.indexOf(`command === '${nextCommand}'`, start)
	return source.slice(start, end)
}

describe('subscriber marketing operator reliability contracts', () => {
	it('reports Gate D from the live learner-flow cohort during rolling enrollment', () => {
		const gateStatus = functionSource(
			'buildValuePathGateDStatus',
			'buildValuePathContactStateInit',
		)
		expect(gateStatus).toContain('queryLearnerFlowCohort({ repository, allowlist })')
		expect(gateStatus).toContain('const contactIds = cohort?.contactIds ?? []')
		expect(gateStatus).toContain('source: cohort?.source')
		expect(gateStatus).toContain('participants: contactIds.length')
		expect(gateStatus).toContain('byContact')
	})

	it('emits aggregate-only stuck summaries without customer rows', () => {
		const stuckList = commandSource(
			'learner-flow-stuck-list',
			'learner-flow-unstick',
		)
		expect(stuckList).toContain("args.includes('--summary-only')")
		expect(stuckList).toContain('stuck: _customerRows')
		expect(stuckList).toContain('JSON.stringify(summary')
	})

	it('keeps retry sends out of the broad learner-flow unstick command', () => {
		const unstick = functionSource(
			'buildLearnerFlowUnstick',
			'buildValuePathGateDPreview',
		)
		expect(unstick).not.toContain('retryIntentIds')
		expect(unstick).not.toContain('retryableIntentIds')
		expect(unstick).not.toContain('executePendingValuePathEmailIntents')
		expect(unstick).toContain('allowWrite: args.allowWrite')
		expect(source).toContain("command === 'value-path-email-executor'")
	})
})
