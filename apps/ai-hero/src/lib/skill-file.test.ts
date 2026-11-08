import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	deriveSkillFileRef,
	getSkillFile,
	skillFileSourceUrl,
	splitSkillFile,
} from './skill-file'

describe('deriveSkillFileRef', () => {
	it.each([
		[
			'https://github.com/mattpocock/skills/blob/main/docs/engineering/to-spec.md',
			'skills/engineering/to-spec/SKILL.md',
		],
		[
			'https://raw.githubusercontent.com/mattpocock/skills/main/docs/engineering/grill-with-docs.md',
			'skills/engineering/grill-with-docs/SKILL.md',
		],
		[
			'mattpocock/skills/docs/productivity/grill-me.md',
			'skills/productivity/grill-me/SKILL.md',
		],
	])('maps a guide source to its matching skill file', (source, path) => {
		expect(deriveSkillFileRef(source)).toMatchObject({
			owner: 'mattpocock',
			repo: 'skills',
			ref: 'main',
			path,
		})
	})

	it.each([
		undefined,
		'',
		'https://github.com/other/skills/blob/main/docs/engineering/to-spec.md',
		'https://github.com/mattpocock/skills/blob/main/README.md',
		'https://github.com/mattpocock/skills/blob/main/docs/resolving-merge-conflicts.md',
	])('does not guess outside the verified docs convention', (source) => {
		expect(deriveSkillFileRef(source)).toBeNull()
	})
})

describe('skill file content', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('keeps frontmatter visible separately from the rendered body', () => {
		expect(
			splitSkillFile('---\nname: to-spec\ndescription: Record it\n---\n\n# Process'),
		).toEqual({
			frontmatter: 'name: to-spec\ndescription: Record it',
			body: '\n# Process',
		})
	})

	it('returns the whole file as the body when there is no frontmatter', () => {
		expect(splitSkillFile('# Process')).toEqual({
			frontmatter: null,
			body: '# Process',
		})
	})

	it('fetches the derived public file and builds an exact GitHub permalink', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response('---\nname: to-spec\n---\n# Process', { status: 200 }),
		)
		vi.stubGlobal('fetch', fetchMock)

		await expect(
			getSkillFile(
				'https://github.com/mattpocock/skills/blob/main/docs/engineering/to-spec.md',
			),
		).resolves.toEqual({
			frontmatter: 'name: to-spec',
			body: '# Process',
			sourceUrl:
				'https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md',
		})
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('degrades to no viewer when the source file cannot be fetched', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('Not found', { status: 404 })),
		)

		await expect(
			getSkillFile(
				'https://github.com/mattpocock/skills/blob/main/docs/engineering/missing.md',
			),
		).resolves.toBeNull()
	})

	it('encodes source URL segments', () => {
		expect(
			skillFileSourceUrl({
				owner: 'mattpocock',
				repo: 'skills',
				ref: 'release 1',
				path: 'skills/productivity/grill me/SKILL.md',
			}),
		).toBe(
			'https://github.com/mattpocock/skills/blob/release%201/skills/productivity/grill%20me/SKILL.md',
		)
	})
})
