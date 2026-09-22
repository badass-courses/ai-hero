import { describe, expect, it, vi } from 'vitest'

import {
	buildAgentPrompt,
	copyAgentPrompt,
	createAgentPrompt,
	agentPromptReducer,
} from './analytics-agent-api-card'

describe('analytics agent prompt', () => {
	it('builds a prompt from the generated token without persistence', () => {
		const prompt = buildAgentPrompt({
			appName: 'AI Hero',
			endpoint: 'https://example.test/api/analytics',
			token: 'token-for-test-only',
			ttlLabel: '90 days',
			expiresAt: '2026-12-21T00:00:00.000Z',
			surfaces: [{
				name: 'summary',
				description: 'Revenue overview',
				category: 'revenue',
			}],
		})

		expect(prompt).toContain('Bearer token-for-test-only')
		expect(prompt).toContain('summary')
		expect(prompt).not.toContain('localStorage')
	})

	it('keeps token generation separate from a copy retry', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						token: 'token-for-test-only',
						ttlLabel: '90 days',
						expiresAt: '2026-12-21T00:00:00.000Z',
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						surfaces: [],
					}),
				),
			)

		const result = await createAgentPrompt({
				appName: 'AI Hero',
				endpoint: 'https://example.test/api/analytics',
				fetchImpl,
			})
		const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'))

		await expect(copyAgentPrompt(result.prompt, { writeText })).rejects.toThrow(
			'clipboard denied',
		)
		await expect(copyAgentPrompt(result.prompt, { writeText })).rejects.toThrow(
			'clipboard denied',
		)

		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(writeText).toHaveBeenCalledTimes(2)
	})

	it('transitions a denied clipboard into a manual-copy state with the prompt intact', () => {
		const generating = agentPromptReducer(
			{ status: 'idle', prompt: null, error: null },
			{ type: 'generate-start' },
		)
		const manual = agentPromptReducer(generating, {
			type: 'manual-copy',
			prompt: 'prompt text',
			error: 'Clipboard access was denied. Select the prompt below and copy it.',
		})

		expect(manual).toEqual({
			status: 'manual-copy',
			prompt: 'prompt text',
			error: 'Clipboard access was denied. Select the prompt below and copy it.',
		})
	})
})
