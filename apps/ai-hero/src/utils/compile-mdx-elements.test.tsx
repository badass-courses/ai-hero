import { renderToReadableStream } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

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

const CANARY = 'xss-canary-40b1'

async function render(
	source: string,
	components: Parameters<typeof compileMDX>[1] = {},
) {
	const { content } = await compileMDX(source, components)
	const stream = await renderToReadableStream(content)
	return new Response(stream).text()
}

describe('CMS MDX cannot plant script or documents (sec-040)', () => {
	it.each([
		`<script>{'${CANARY}'}</script>`,
		`<script dangerouslySetInnerHTML={{ __html: '${CANARY}' }} />`,
		`<iframe srcDoc="<b>${CANARY}</b>" />`,
		`<iframe src="https://example.com/${CANARY}" />`,
		`<object data="https://example.com/${CANARY}" />`,
		`<embed src="https://example.com/${CANARY}" />`,
		`<base href="https://example.com/${CANARY}/" />`,
		`<meta httpEquiv="refresh" content="0;url=https://example.com/${CANARY}" />`,
		`<link rel="stylesheet" href="https://example.com/${CANARY}.css" />`,
		`<style>{'body{background:url(https://example.com/${CANARY})}'}</style>`,
		`<form action="https://example.com/${CANARY}"><button>go</button></form>`,
		`<div dangerouslySetInnerHTML={{ __html: '<img src=x onerror=${CANARY}>' }} />`,
		`<img src="x.png" onError="${CANARY}" />`,
		`<button formAction="https://example.com/${CANARY}">go</button>`,
		`<a href="data:text/html,${CANARY}">x</a>`,
		`<a href={'data:text/html,${CANARY}'}>x</a>`,
		'<a href={`data:text/html,' + CANARY + '`}>x</a>',
		`<svg><a><animate attributeName="href" values="javascript:${CANARY}" /><text>t</text></a></svg>`,
		`<svg><a><set attributeName="href" to="javascript:${CANARY}" /><text>t</text></a></svg>`,
		`<svg><animateMotion path="${CANARY}" /></svg>`,
		`<svg><animateTransform type="${CANARY}" /></svg>`,
	])('drops it: %s', async (source) => {
		const html = await render(`# Hi\n\nBefore\n\n${source}\n\nAfter`)
		expect(html).toContain('After')
		expect(html).not.toContain(CANARY)
	})

	it('drops unsafe JSX passed inside a data prop', async () => {
		const Probe = (props: { icon?: React.ReactNode }) => <div>{props.icon}</div>
		const html = await render(
			`<Probe icon={<script>{'${CANARY}'}</script>} />`,
			{ Probe },
		)
		expect(html).not.toContain(CANARY)
	})

	it('drops a literal unsafe URL in JSX inside a data prop', async () => {
		const Probe = (props: { icon?: React.ReactNode }) => <div>{props.icon}</div>
		const html = await render(
			`<Probe icon={<a href={'data:text/html,${CANARY}'}>x</a>} />`,
			{ Probe },
		)
		expect(html).not.toContain(CANARY)
	})

	it('refuses constructor member segments in element names', async () => {
		const Probe = () => <span>probe</span>
		const html = await render('<Probe.constructor>x</Probe.constructor>', {
			Probe,
		})
		expect(html).not.toContain('probe')
	})

	it('keeps ordinary markup, links and images', async () => {
		const html = await render(
			'<div className="note">kept</div>\n\n<a href="https://example.org/docs">link</a>\n\n<img src="https://res.cloudinary.com/a.png" alt="pic" />',
		)
		expect(html).toContain('kept')
		expect(html).toContain('https://example.org/docs')
		expect(html).toContain('https://res.cloudinary.com/a.png')
	})
})
