import {
	fetchGithubMarkdownFile,
	parseGithubSource,
	type GithubMarkdownFileRef,
} from '@/lib/github-markdown'
import { parse as parseYaml } from 'yaml'

export type SkillMetadataEntry = { key: string; value: string }

export type SkillFile = {
	body: string
	metadata: SkillMetadataEntry[] | null
	sourceUrl: string
}

/**
 * Skill guide posts sync from `docs/<category>/<name>.md`. The agent-facing
 * file follows the repository's matching `skills/<category>/<name>/SKILL.md`
 * convention. Keep this deliberately narrow: a source outside that convention
 * should not invent a file path and show the wrong skill.
 */
export function deriveSkillFileRef(
	githubSource: string | null | undefined,
): GithubMarkdownFileRef | null {
	if (!githubSource) return null

	const guide = parseGithubSource(githubSource)
	if (
		!guide ||
		guide.owner.toLowerCase() !== 'mattpocock' ||
		guide.repo.toLowerCase() !== 'skills'
	) {
		return null
	}

	const match = guide.path.match(/^docs\/([^/]+)\/([^/]+)\.md$/)
	if (!match?.[1] || !match[2]) return null

	return {
		owner: guide.owner,
		repo: guide.repo,
		ref: guide.ref,
		path: `skills/${match[1]}/${match[2]}/SKILL.md`,
	}
}

export function splitSkillFile(markdown: string): {
	body: string
	frontmatter: string | null
} {
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
	if (!match) return { body: markdown, frontmatter: null }

	return {
		frontmatter: match[1] ?? '',
		body: markdown.slice(match[0].length),
	}
}

/**
 * Turns SKILL.md frontmatter into display rows. Lists join with commas and
 * nested objects print as compact JSON. Frontmatter that is not a YAML mapping
 * shows no metadata rather than failing the whole viewer.
 */
export function parseSkillMetadata(
	frontmatter: string | null,
): SkillMetadataEntry[] | null {
	if (frontmatter === null) return null

	try {
		const data: unknown = parseYaml(frontmatter)
		if (data === null || typeof data !== 'object' || Array.isArray(data)) {
			return null
		}

		const entries = Object.entries(data).map(([key, value]) => ({
			key,
			value: Array.isArray(value)
				? value.map(String).join(', ')
				: value !== null && typeof value === 'object'
					? JSON.stringify(value)
					: String(value),
		}))
		return entries.length > 0 ? entries : null
	} catch {
		// Malformed YAML, or a self-referencing alias JSON.stringify cannot print.
		return null
	}
}

export function skillFileSourceUrl(ref: GithubMarkdownFileRef): string {
	const path = ref.path.split('/').map(encodeURIComponent).join('/')
	return `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/blob/${encodeURIComponent(ref.ref)}/${path}`
}

/** Fetches a skill file for the public docs viewer without making page failure fatal. */
export async function getSkillFile(
	githubSource: string | null | undefined,
): Promise<SkillFile | null> {
	const ref = deriveSkillFileRef(githubSource)
	if (!ref) return null

	try {
		const markdown = await fetchGithubMarkdownFile({
			...ref,
			transport: 'raw-only',
			revalidate: 3600,
			tags: [`skill-file:${ref.path}`],
		})
		const { body, frontmatter } = splitSkillFile(markdown)

		return {
			body,
			metadata: parseSkillMetadata(frontmatter),
			sourceUrl: skillFileSourceUrl(ref),
		}
	} catch {
		return null
	}
}
