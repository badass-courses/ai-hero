import { evaluate } from '@mdx-js/mdx'
import { renderToStaticMarkup } from 'react-dom/server'
import * as runtime from 'react/jsx-runtime'
import { describe, expect, it } from 'vitest'

import { remarkLiteralPlaceholders } from './remark-literal-placeholders'

async function render(source: string) {
	const { default: Content } = await evaluate(source, {
		...(runtime as any),
		remarkPlugins: [remarkLiteralPlaceholders],
	})
	return renderToStaticMarkup(<Content />)
}

describe('remarkLiteralPlaceholders', () => {
	it('renders a bare-name placeholder in prose as literal text instead of throwing', async () => {
		// The production crash: an email-subject template in a lesson body.
		const html = await render('- Email subject: **"Refund requested - {course}"**')
		expect(html).toContain('Refund requested - {course}')
	})

	it('handles member paths and flow-level placeholders', async () => {
		const html = await render('Hello {input.courseTitle}\n\n{course}\n')
		expect(html).toContain('Hello {input.courseTitle}')
		expect(html).toContain('<p>{course}</p>')
	})

	it('leaves real expressions alone', async () => {
		const html = await render("a{' '}b {2 * 3} {/* note */}")
		expect(html).toBe('<p>a b 6 </p>')
	})
})
