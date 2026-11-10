import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/ignore-build.mjs', import.meta.url))
const fixtures: string[] = []
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

const fixture = (files: string[], beforeFiles: string[] = ['README.md']) => {
	const root = mkdtempSync(join(tmpdir(), 'ai-hero-ignore-build-'))
	fixtures.push(root)
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
	git('init', '-q')
	git('config', 'user.name', 'Build Test')
	git('config', 'user.email', 'build@example.test')
	git('config', 'commit.gpgsign', 'false')
	const write = (paths: string[], content: string) => {
		for (const path of paths) {
			mkdirSync(dirname(join(root, path)), { recursive: true })
			writeFileSync(join(root, path), content)
		}
	}
	write(beforeFiles, 'before\n')
	git('add', '.')
	git('commit', '-qm', 'base')
	const previous = git('rev-parse', 'HEAD')
	write(files, 'after\n')
	git('add', '.')
	git('commit', '--allow-empty', '-qm', 'change')
	const current = git('rev-parse', 'HEAD')
	const app = join(root, 'apps/ai-hero')
	mkdirSync(app, { recursive: true })
	return {
		git,
		run: (env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [script], {
			cwd: app,
			env: {
				...process.env,
				VERCEL_ENV: 'preview',
				VERCEL_GIT_PREVIOUS_SHA: previous,
				VERCEL_GIT_COMMIT_SHA: current,
				...env,
			},
		}).status,
	}
}

describe('Vercel ignored-build decision table', () => {
	it('wires the ignored-build command to the standalone script', () => {
		const config = JSON.parse(readFileSync('vercel.json', 'utf8'))
		expect(config.ignoreCommand).toBe('node scripts/ignore-build.mjs')
	})

	it.each(['production', 'development', '', undefined])('builds outside previews (%s)', (environment) => {
		expect(fixture(['README.md']).run({ VERCEL_ENV: environment })).toBe(1)
	})

	it.each(['VERCEL_GIT_PREVIOUS_SHA', 'VERCEL_GIT_COMMIT_SHA'])('builds when %s is missing or unknown', (key) => {
		const repo = fixture(['README.md'])
		for (const value of [undefined, '', 'bad-sha', 'f'.repeat(40)]) {
			expect(repo.run({ [key]: value })).toBe(1)
		}
	})

	it('builds when git is unavailable', () => {
		expect(fixture(['README.md']).run({ PATH: '' })).toBe(1)
	})

	it('builds for a mixed diff', () => {
		expect(fixture(['README.md', 'apps/ai-hero/src/app/page.tsx']).run()).toBe(1)
	})

	it('skips documentation-only previews, including spaces and newlines in paths', () => {
		expect(fixture(['README.md', 'guide.mdx', 'docs/guide.txt', '.brain/note.svx', 'docs/a b\nc.md']).run()).toBe(0)
	})

	it('skips tests-only previews', () => {
		expect(fixture(['apps/ai-hero/src/a.test.ts', 'packages/ui/a.test.tsx', 'apps/ai-hero/src/__tests__/fixture.json', '__tests__/setup.js']).run()).toBe(0)
	})

	it('skips a combined docs-and-tests preview', () => {
		expect(fixture(['README.md', 'apps/ai-hero/src/a.test.ts']).run()).toBe(0)
	})

	it.each(['apps/ai-hero/src/guide.md', 'apps/ai-hero/src/content/lesson.mdx', 'pnpm-lock.yaml', 'apps/ai-hero/scripts/build.mjs', 'contest.ts'])('builds for %s', (file) => {
		expect(fixture([file]).run()).toBe(1)
	})

	it('builds for an empty diff', () => {
		expect(fixture([]).run()).toBe(1)
	})

	it('builds if a source file was renamed into a docs path', () => {
		const repo = fixture([], ['source.ts'])
		repo.git('mv', 'source.ts', 'guide.md')
		repo.git('commit', '-qm', 'rename')
		expect(repo.run({ VERCEL_GIT_COMMIT_SHA: repo.git('rev-parse', 'HEAD') })).toBe(1)
	})

	it('skips deletion of a docs-only file', () => {
		const repo = fixture([])
		repo.git('rm', 'README.md')
		repo.git('commit', '-qm', 'delete docs')
		expect(repo.run({ VERCEL_GIT_COMMIT_SHA: repo.git('rev-parse', 'HEAD') })).toBe(0)
	})
})
