import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLearnerFlowReport } from '../learner-flow-report'

const current = {
	schemaVersion: 'aih.learner-flow.current.v1',
	productId: 'email-course',
	reportPath: '.brain/data/learner-flow/reports/2026-07-15.json',
	reportSha256: 'abc123',
	generatedAt: '2026-07-15T12:00:00.000Z',
}

const report = {
	schemaVersion: 'aih.learner-flow.report.v1',
	productId: 'email-course',
	snapshotDate: '2026-07-15',
	previousSnapshotDate: '2026-07-14',
	state: 'ready',
	stages: [],
	midPathByEmail: {},
	attribution: {},
	alerts: [],
}

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('getLearnerFlowReport', () => {
	it('returns not-started when the canonical manifest is absent', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
		await expect(getLearnerFlowReport({ token: 'token', fetch: fetcher })).resolves.toEqual({ state: 'not_started' })
	})

	it('returns the exact generated report instead of re-deriving deltas', async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(jsonResponse(current))
			.mockResolvedValueOnce(jsonResponse(report))
		await expect(getLearnerFlowReport({ token: 'token', fetch: fetcher })).resolves.toEqual(report)
		expect(fetcher.mock.calls[0]?.[0]).toContain('/contents/.brain/data/learner-flow/current.json')
		expect(fetcher.mock.calls[1]?.[0]).toContain('/contents/.brain/data/learner-flow/reports/2026-07-15.json')
		expect(fetcher.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer token')
	})

	it('keeps a missing token and source failure non-fatal for the wider analytics API', async () => {
		await expect(getLearnerFlowReport({ token: '' })).resolves.toEqual({ state: 'unavailable', reason: 'support_report_token_missing' })
		await expect(getLearnerFlowReport({ token: 'token', fetch: vi.fn().mockResolvedValue(new Response('', { status: 500 })) })).resolves.toEqual({ state: 'unavailable', reason: 'support_report_source_unavailable' })
	})

	it('rejects a manifest that points outside the fixed aggregate-only report path', async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ...current, reportPath: '../../secrets.json' }))
		await expect(getLearnerFlowReport({ token: 'token', fetch: fetcher })).resolves.toEqual({ state: 'unavailable', reason: 'support_report_manifest_invalid' })
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
})
