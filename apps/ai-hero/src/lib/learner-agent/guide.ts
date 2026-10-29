import {
	COMPANION_RULES,
	learnerCatalog,
	type SiteUrls,
} from '@ai-hero/learner-agent'

/**
 * Agent-facing copy for the learner surface. Markdown, read by agents, not
 * rendered on any HTML page: the visible "Use with your agent" section is
 * separate customer copy with its own review.
 */

const signInSteps = (site: SiteUrls) => [
	'Sign in once, as the learner. Two ways:',
	'',
	`1. Device flow, no browser copy-paste: \`POST ${site.baseUrl}/oauth/device/code\`, ask the learner to open \`verification_uri_complete\` and approve, then poll \`POST ${site.baseUrl}/oauth/token\` with form fields \`device_code=<code>\` and \`scope=learner:read\`. The \`access_token\` it returns reads only what the learner can read, for 90 days.`,
	`2. Agent token: while signed in at ${site.baseUrl}, the learner sends \`POST ${site.baseUrl}/api/learner/token\` and gives you the token. \`GET\` lists their tokens; \`DELETE\` with \`{ "id": "<token id>" }\` revokes one.`,
	'',
	'Send the token as `Authorization: Bearer <token>` on every MCP or HTTP call. Without it you can still use `search_course` on public content.',
]

export function buildCompanionBlock(
	site: SiteUrls,
	course?: { title: string; slug: string },
) {
	return [
		'<!-- agent-only: instructions for AI agents working this course with a learner -->',
		'## For agents: study this course with the learner',
		'',
		`Connect to the AI Hero MCP server at \`${site.mcpUrl}\` (streamable HTTP).`,
		'',
		...signInSteps(site),
		'',
		'Recommended path:',
		'',
		`1. \`my_courses\`: what the learner owns and when each workshop opens.`,
		`2. \`course_outline\`${course ? ` with \`{ "course": "${course.slug}" }\`` : ''}: lessons and what is done.`,
		'3. The `start_lesson` prompt or `read_lesson`: lesson text, transcript and Matt’s session extract.',
		'4. `session_extract` with `atSeconds`: what Matt had on screen at that moment of the video.',
		'5. `mark_complete` once it ships; until then the learner marks lessons done on the lesson page.',
		'',
		'How to be a study companion:',
		'',
		...COMPANION_RULES.map((rule) => `- ${rule}`),
		'',
		`Full guide: ${site.instructionsUrl}`,
		'<!-- /agent-only -->',
	].join('\n')
}

/**
 * Puts the companion block at the top of a markdown twin, after its YAML
 * frontmatter, which must stay first for parsers to find it.
 */
export function withCompanionBlock(markdown: string, block: string) {
	if (!markdown.startsWith('---\n')) return `${block}\n\n${markdown}`
	const end = markdown.indexOf('\n---\n', 4)
	if (end === -1) return `${block}\n\n${markdown}`
	const split = end + '\n---\n'.length
	return `${markdown.slice(0, split)}\n${block}\n${markdown.slice(split)}`
}

export function buildLearnerAgentGuide(site: SiteUrls) {
	const catalog = learnerCatalog()
	return [
		'# AI Hero learner agent surface',
		'',
		'Tools for an enrolled learner’s own agent: see what they own, read the outline and lessons, read Matt’s session extract at a timestamp, search, and see office hours. Every response carries `next_actions`.',
		'',
		'## Connect',
		'',
		`MCP (streamable HTTP, stateless): \`${site.mcpUrl}\``,
		'',
		'Claude Code:',
		'',
		'```sh',
		`claude mcp add --transport http aihero ${site.mcpUrl} --header "Authorization: Bearer <token>"`,
		'```',
		'',
		'Cursor (`~/.cursor/mcp.json`):',
		'',
		'```json',
		JSON.stringify(
			{
				mcpServers: {
					aihero: {
						url: site.mcpUrl,
						headers: { Authorization: 'Bearer <token>' },
					},
				},
			},
			null,
			2,
		),
		'```',
		'',
		'Codex (`~/.codex/config.toml`):',
		'',
		'```toml',
		'[mcp_servers.aihero]',
		`url = "${site.mcpUrl}"`,
		'bearer_token_env_var = "AIHERO_TOKEN"',
		'```',
		'',
		'<a id="sign-in"></a>',
		'## Sign in',
		'',
		...signInSteps(site),
		'',
		'## Tools',
		'',
		...catalog.tools.map((tool) => `- \`${tool.name}\`: ${tool.description}`),
		'',
		'Prompts:',
		'',
		...catalog.prompts.map(
			(prompt) => `- \`${prompt.name}\`: ${prompt.description}`,
		),
		'',
		'## HTTP',
		'',
		`Each tool is also \`POST ${site.baseUrl}/api/learner/<tool>\` with a JSON body, and \`GET\` with query parameters for read-only tools. OpenAPI: ${site.baseUrl}/api/openapi.json.`,
		'',
		'## Study companion rules',
		'',
		...COMPANION_RULES.map((rule) => `- ${rule}`),
		'',
	].join('\n')
}
