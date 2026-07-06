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

  CONTENT-OPS: DONE 2026-07-06 (session 4). All six topic tags exist
  (understand-the-basics `qogn9`, build-ai-apps `2784v`, connect-tools-mcp
  `ueaht`, code-with-ai-agents `v2tba`, level-up-your-workflow `dezxr`,
  test-and-evaluate `khqa0` — no `skill-phase` context) and the 22 curated
  POSTS below are attached to their section's tag (see
  OPERATIONS.md session 4 + dumps/topic-tagging/). The four tutorial LINKS
  (LLM Fundamentals, AI Engineer Roadmap, Vercel AI SDK Tutorial, Model
  Context Protocol Tutorial) are `list` resources — getPostsByTag filters
  type='post', so they stay curated-only by design.

  OPEN (Vojta): with tags attached, each TopicSection now renders curated
  links AND the same posts tag-driven (no code dedupe; tag order is
  createdAt desc). Either trim curated post links from this page body
  (loses pedagogical order, keeps the tutorial links) or keep curation and
  accept duplicates until a dedupe/ordering decision.

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
