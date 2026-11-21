import { renderToReadableStream } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/cohort-office-hours-query', () => ({
	getCohortOfficeHoursSessionsForWorkshop: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/server/logger', () => ({
	log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(),
}))

import { compileMDX } from './compile-mdx'

const CANARY = 'mdx-canary-7f3a9c'

async function render(
	source: string,
	options: Parameters<typeof compileMDX>[2] = {},
	components: Parameters<typeof compileMDX>[1] = {},
) {
	const { content } = await compileMDX(source, components, options)
	const stream = await renderToReadableStream(content)
	return new Response(stream).text()
}

describe('CMS MDX expressions carry data, never code (sec-036)', () => {
	beforeAll(() => {
		process.env.MDX_CANARY = CANARY
	})
	afterAll(() => {
		delete process.env.MDX_CANARY
	})

	it.each([
		'{process.env.MDX_CANARY}',
		'{globalThis.process.env.MDX_CANARY}',
		"{globalThis['pro' + 'cess'].env.MDX_CANARY}",
		"{Reflect.get(globalThis, 'pro' + 'cess').env.MDX_CANARY}",
		'{Object.values(Object.getOwnPropertyDescriptors(globalThis)).map((d) => d.value).find((v) => v && v.env && v.versions).env.MDX_CANARY}',
		"<span title={Reflect.get(globalThis, 'pro' + 'cess').env.MDX_CANARY}>x</span>",
		// Computed keys built at runtime get past blockDangerousJS's denylist.
		"{({})['constr' + 'uctor']['constr' + 'uctor']('return pro' + 'cess')().env.MDX_CANARY}",
		'{({})[`constructor`][`constructor`](`return pro` + `cess`)().env.MDX_CANARY}',
		"<span title={({})['constr' + 'uctor']['constr' + 'uctor']('return pro' + 'cess')().env.MDX_CANARY}>x</span>",
	])('a body cannot read server env: %s', async (expression) => {
		const html = await render(`# Hi\n\nBefore ${expression} after`)
		expect(html).not.toContain(CANARY)
	})

	it('keeps authored data props: arrays, objects, numbers, JSX icons', async () => {
		const Probe = (props: Record<string, unknown>) => (
			<pre>{JSON.stringify(props)}</pre>
		)
		const html = await render(
			`<Probe items={[{ label: 'a', on: true }, 'b']} width={737/1.2} icon={<span>!</span>} flag={false} />`,
			{},
			{ Probe },
		)
		expect(html).toContain('&quot;label&quot;:&quot;a&quot;')
		expect(html).toContain('614.1666')
		expect(html).toContain('&quot;flag&quot;:false')
		expect(html).toContain('&quot;icon&quot;')
	})

	it('keeps scope values passed as props', async () => {
		const Probe = (props: { pct?: number }) => <b>Save {props.pct}%</b>
		const html = await render(
			'<Probe pct={percentOff} />',
			{ scope: { percentOff: 20 } },
			{ Probe },
		)
		expect(html).toMatch(/Save (<!-- -->)?20(<!-- -->)?%/)
	})

	it('drops calls even on scope names', async () => {
		const html = await render('{percentOff.constructor.name}', {
			scope: { percentOff: 20 },
		})
		expect(html).not.toContain('Number')
	})
})
