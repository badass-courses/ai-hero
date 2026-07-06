{/*
  v1 seed for the CMS `hub-sidebar` page (type: page, slug: hub-sidebar,
  state: published). Compiled by `HubLayout` with the sidebar-scoped MDX map
  (`src/components/navigation/sidebar/sidebar-mdx.tsx`).

  Component vocabulary:
  - `<SidebarSection title="…">` — collapsible group; markdown link lists nest inside
  - `- [Label](/href)` — sidebar link (active state + analytics come free)
  - `<WhatsNew />` — latest 3 published public posts + "See all" → /posts
  - `<SkillsNav />` — the skill cycle from the SKILLS_LIST_ID list (renders
    nothing until skill posts exist, so it's safe to include now)
  - `<TopicSection tag="…" label="…" limit={5}>` — topic tag section: label
    from the CMS tag (the `label` prop is the fallback while the tag doesn't
    exist yet), top N tagged posts, "All →" link to /topics/[tag]. Curated
    markdown links inside render above the tag-driven posts.

  CONTENT-OPS TODO (verified against prod DB 2026-07-06 — only `ai-sdk`,
  `evalite`, `personal-software` tags exist): create these six topic tags via
  the cb CLI, then tag posts. Until then each section renders its curated
  links only (no "All →" link, no auto posts):
  - understand-the-basics  (label: Understand the Basics)
  - build-ai-apps          (label: Build AI Apps)
  - connect-tools-mcp      (label: Connect Tools (MCP))
  - code-with-ai-agents    (label: Code with AI Agents)
  - level-up-your-workflow (label: Level Up Your Workflow)
  - test-and-evaluate      (label: Test & Evaluate)
  Do NOT give these tags `fields.contexts: ["skill-phase"]` — that context is
  reserved for skill cycle phases and is excluded from topic surfaces.

  Once tags are populated, the curated lists below can be trimmed — tagged
  posts will appear automatically (curated links render above them, so
  duplicates are possible until then; dedupe by curation, not code).

  Every link below is a real production URL (curated from the live corpus,
  2026-07-06). Amy's seven-section taxonomy: lat.md/upstream.md#Topic taxonomy.
*/}

<SidebarSection title="Explore">

- [Map](/learn)
- [Principles](/principles)
- [Tools](/tools)

</SidebarSection>

<WhatsNew />

<SkillsNav />

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
