import { describe, expect, it, vi } from 'vitest'

import {
	checkKitCustomFields,
	readSubscriberRow183Fields,
	ROW_183_KIT_FIELDS,
} from './kit-custom-fields-check'

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})

describe('kit custom fields check (read-only)', () => {
	it('answers yes/no per key from one GET, never a write', async () => {
		const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
			expect(init?.method).toBe('GET')
			return json({
				custom_fields: [{ key: 'aih_evergreen_deadline_display' }, { key: 'other' }],
			})
		})
		expect(
			await checkKitCustomFields({
				apiKey: 'k',
				keys: ROW_183_KIT_FIELDS,
				fetcher: fetcher as unknown as typeof fetch,
			}),
		).toEqual({
			aih_course_entry_evidence: false,
			aih_evergreen_deadline_display: true,
			aih_evergreen_deadline_short: false,
		})
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(String(fetcher.mock.calls[0]![0])).toContain('/v3/custom_fields?')
	})

	it('reads a test subscriber: the evidence value and whether attribution is set', async () => {
		const fetcher = vi.fn(async (_url: URL | RequestInfo) =>
			json({
				subscribers: [
					{
						fields: {
							aih_course_entry_evidence: '{"type":"BrowserEntryHeader"}',
							aih_optin_attribution: '{"landing_path":"/skills"}',
						},
					},
				],
			}),
		)
		expect(
			await readSubscriberRow183Fields({
				apiSecret: 's',
				email: 'Test@Example.com',
				fetcher: fetcher as unknown as typeof fetch,
			}),
		).toEqual({
			found: true,
			courseEntryEvidence: '{"type":"BrowserEntryHeader"}',
			attributionStashed: true,
		})
		expect(String(fetcher.mock.calls[0]![0])).toContain(
			'email_address=test%40example.com',
		)
	})
})
