import { afterEach, describe, expect, it, vi } from 'vitest'
import { readOwnedSkillsAdmission } from './owned-skills-list-state'

const base = {
	contactId: 'contact-1',
	kitSubscriberId: null,
	tenantId: 'org-aihero',
	scope: 'all',
	state: 'confirmed',
	forms: [],
	stops: [],
	unknownReason: null,
}
const config = (body: unknown, status = 200) => ({
	baseUrl: 'https://drovr.example.test',
	apiKey: 'synthetic',
	fetch: vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify(body), { status })),
})

afterEach(() => {
	vi.useRealTimers()
})

describe('owned signed-in Skills stop admission', () => {
	it.each([
		['confirmed profile with no forms', { ...base, evidence: 'profile' }],
		[
			'confirmed form',
			{ ...base, forms: [{ formId: 'skills-newsletter', state: 'confirmed' }] },
		],
		[
			'unrelated confirmed form',
			{ ...base, forms: [{ formId: 'other', state: 'confirmed' }] },
		],
		['unconfirmed', { ...base, state: 'unconfirmed' }],
		[
			'no consent evidence',
			{ ...base, state: 'unknown', unknownReason: 'no-consent-evidence' },
		],
		[
			'no drovr identity',
			{
				...base,
				contactId: null,
				state: 'unknown',
				unknownReason: 'no-contact',
			},
		],
	])(
		'%s allows the verified signed-in click, without a Kit call',
		async (_name, list) => {
			const c = config(list)
			expect(await readOwnedSkillsAdmission('contact-1', c)).toMatchObject({
				status: 'allow',
			})
			expect(c.fetch).toHaveBeenCalledOnce()
			expect(c.fetch.mock.calls[0]![0]).toBe(
				'https://drovr.example.test/contact-list-state?contactId=contact-1',
			)
		},
	)

	it.each(['all', 'course:value-path-skills-course'])(
		'a %s stop takes DOI',
		async (scope) => {
			expect(
				await readOwnedSkillsAdmission(
					'contact-1',
					config({
						...base,
						stops: [
							{
								createdAt: '2026-11-01T05:00:00Z',
								reason: 'unsubscribed',
								scope,
							},
						],
					}),
				),
			).toMatchObject({ status: 'doi' })
		},
	)

	it.each([
		['503', base, 503],
		['typed error', { type: 'contact-list-state-unavailable' }, 200],
		['malformed', {}, 200],
		['identity mismatch', { ...base, contactId: 'another-contact' }, 200],
	])(
		'%s is unavailable, never a no-consent admission or a DOI decision',
		async (_name, body, status) => {
			expect(
				await readOwnedSkillsAdmission('contact-1', config(body, status)),
			).toEqual({ status: 'unavailable' })
		},
	)

	it('network failure, missing configuration and timeout defer rather than enrolling or sending DOI', async () => {
		expect(await readOwnedSkillsAdmission('contact-1', undefined)).toEqual({
			status: 'unavailable',
		})
		expect(
			await readOwnedSkillsAdmission('contact-1', {
				...config(base),
				fetch: vi.fn().mockRejectedValue(new Error('unreachable')),
			}),
		).toEqual({ status: 'unavailable' })
		vi.useFakeTimers()
		const result = readOwnedSkillsAdmission('contact-1', {
			...config(base),
			fetch: vi.fn(() => new Promise<Response>(() => {})),
		})
		await vi.advanceTimersByTimeAsync(1500)
		expect(await result).toEqual({ status: 'unavailable' })
	})
})
