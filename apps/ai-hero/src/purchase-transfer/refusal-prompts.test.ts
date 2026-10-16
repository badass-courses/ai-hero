import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	SUPPORT_TRANSFER_REFUSAL_PROMPTS,
	supportTransferRefusalPrompt,
} from './refusal-prompts'

const sourceReasons = (file: string) =>
	[
		...readFileSync(join(__dirname, file), 'utf8').matchAll(
			/(?:reason: |\| )'([a-z_]+)'/g,
		),
	].map((match) => match[1]!)

describe('support transfer refusal prompts', () => {
	it.each(['support-complete.ts', 'support-initiate.ts'])(
		'every reason %s can return has its own literal prompt',
		(file) => {
			const reasons = new Set(sourceReasons(file))
			expect(reasons.size).toBeGreaterThan(5)
			for (const reason of reasons) {
				expect(
					SUPPORT_TRANSFER_REFUSAL_PROMPTS,
					`${file} returns '${reason}' with no prompt`,
				).toHaveProperty(reason)
			}
		},
	)

	it('each prompt says what to do and is not the generic fallback', () => {
		for (const [reason, prompt] of Object.entries(
			SUPPORT_TRANSFER_REFUSAL_PROMPTS,
		)) {
			expect(prompt, reason).toMatch(/^(Refused|Pending): /)
			expect(prompt, reason).not.toContain('Escalate to engineering with this reason')
			expect(prompt.length, reason).toBeGreaterThan(30)
		}
		expect(new Set(Object.values(SUPPORT_TRANSFER_REFUSAL_PROMPTS)).size).toBe(
			Object.keys(SUPPORT_TRANSFER_REFUSAL_PROMPTS).length,
		)
	})

	it('names the limits in the evidence prompt', () => {
		const prompt = supportTransferRefusalPrompt('same_person_evidence_invalid')
		expect(prompt).toContain('1000')
		expect(prompt).toContain('255')
		expect(prompt).toContain('@')
	})

	it('an unknown reason still gets a literal prompt that changes nothing', () => {
		expect(supportTransferRefusalPrompt('brand_new_reason')).toBe(
			'Refused: brand_new_reason. Nothing was changed. Escalate to engineering with this reason.',
		)
	})
})
