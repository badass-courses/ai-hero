/**
 * Default hub-sidebar MDX — the single-source-of-truth authoring format
 * (same as the live CMS `hub-sidebar` page). Compiled by `HubLayout` as the
 * fallback when that page is missing/unpublished/empty or its body fails to
 * compile, so degraded mode renders the same sidebar structure rather than a
 * separately hand-modeled one. This constant is the repo's canonical copy and
 * the seed the CMS page is created from — keep it in sync with that page.
 *
 * Authoring notes (component vocabulary, the tutorial-links-are-lists caveat)
 * live in `content-ops/hub-sidebar-seed.mdx` in the project working hub; only
 * the renderable body is embedded here.
 */
export const HUB_SIDEBAR_FALLBACK_MDX = `<SidebarSection title="Explore">

- [Map](/learn)
- [Principles](/principles)
- [Tools](/tools)

</SidebarSection>

<WhatsNew title="What's New" />

<SkillsNav title="Skills" />

<TopicSection tag="understand-the-basics" label="Understand the Basics">

- [LLM Fundamentals](/llm-fundamentals)
- [AI Engineer Roadmap](/ai-engineer-roadmap)
- [What Is An LLM?](/what-is-an-llm)
- [What Are Tokens?](/what-are-tokens)
- [What Is The Context Window?](/what-is-the-context-window)
- [What Is An Agent?](/what-is-an-agent)

</TopicSection>

<TopicSection tag="build-ai-apps" label="Build AI Apps">

- [Vercel AI SDK Tutorial](/vercel-ai-sdk-tutorial)
- [What Is Vercel's AI SDK?](/what-is-the-ai-sdk)
- [17 Techniques For Improving Your LLM-Powered App](/how-to-improve-your-llm-powered-app)
- [Securing your AI App with Guardrails](/securing-your-ai-app-with-guardrails)

</TopicSection>

<TopicSection tag="connect-tools-mcp" label="Connect Tools (MCP)">

- [Model Context Protocol Tutorial](/model-context-protocol-tutorial)
- [How Does The Model Context Protocol Work?](/how-does-the-model-context-protocol-work)
- [Connect Claude Code To A GitHub MCP Server](/connect-claude-code-to-github)
- [Publish Your MCP Server To NPM](/publish-your-mcp-server-to-npm)

</TopicSection>

<TopicSection tag="code-with-ai-agents" label="Code with AI Agents">

- [An Introduction To Plan Mode](/plan-mode-introduction)
- [A Complete Guide To AGENTS.md](/a-complete-guide-to-agents-md)
- [Real-world feature build with Claude Code](/real-world-feature-build-with-claude-code)
- [5 Agent Skills I Use Every Day](/5-agent-skills-i-use-every-day)

</TopicSection>

<TopicSection tag="level-up-your-workflow" label="Level Up Your Workflow">

- [My 7 Phases Of AI Development](/my-7-phases-of-ai-development)
- [How To Make Codebases AI Agents Love](/how-to-make-codebases-ai-agents-love)
- [Tracer Bullets: Keeping AI Slop Under Control](/tracer-bullets)
- [Essential AI Coding Feedback Loops For TypeScript Projects](/essential-ai-coding-feedback-loops-for-type-script-projects)

</TopicSection>

<TopicSection tag="test-and-evaluate" label="Test & Evaluate">

- [Your App Is Only As Good As Its Evals](/what-are-evals)
- [The Three Types Of Evals](/three-types-of-evals)
- [Evalite v1 Preview](/evalite-v1-preview)
- [tdd: Red, Green, Refactor for Agentic Coding](/skills-tdd)

</TopicSection>

<SidebarSection title="Look It Up">

- [AI Coding Dictionary](/ai-coding-dictionary)
- [All posts](/posts)

</SidebarSection>
`
