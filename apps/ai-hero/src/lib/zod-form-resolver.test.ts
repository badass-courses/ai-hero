import { zodResolver } from '@hookform/resolvers/zod'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

// @hookform/resolvers 3.x read `error.errors`, which zod 4 no longer exposes,
// so every invalid submit threw a raw ZodError instead of producing field errors.
describe('zodResolver with zod 4', () => {
	it('maps invalid input to field errors instead of throwing', async () => {
		const schema = z.object({
			name: z.string().min(2),
			price: z.coerce.number().gte(0).default(0),
		})
		const resolve = zodResolver(schema)
		const result = await resolve(
			{ name: 'x', price: '-1' },
			undefined,
			{ fields: {}, shouldUseNativeValidation: false },
		)
		expect(result.values).toEqual({})
		expect(Object.keys(result.errors)).toEqual(['name', 'price'])
		expect(result.errors.name?.type).toBe('too_small')
	})

	it('returns coerced output for valid input', async () => {
		const schema = z.object({ price: z.coerce.number().default(0) })
		const result = await zodResolver(schema)({ price: '12' }, undefined, {
			fields: {},
			shouldUseNativeValidation: false,
		})
		expect(result.errors).toEqual({})
		expect(result.values).toEqual({ price: 12 })
	})
})
