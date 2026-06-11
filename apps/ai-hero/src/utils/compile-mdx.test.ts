import { describe, expect, it } from 'vitest'

import { sanitizeMdxSource } from './compile-mdx'

describe('sanitizeMdxSource', () => {
	it('removes html comments before MDX compilation', () => {
		const source = `<!-- cohort-004-source-grounded -->
# Lesson

<!-- sourcePath: lesson/readme.md -->

Body copy.`

		expect(sanitizeMdxSource(source)).toBe(`
# Lesson



Body copy.`)
	})
})
