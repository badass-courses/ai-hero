/**
 * Default hub-sidebar MDX — the single-source-of-truth authoring format
 * (same as the live CMS `hub-sidebar` page). Compiled by `HubLayout` as the
 * fallback when that page is missing/unpublished/empty or its body fails to
 * compile, so degraded mode renders the same sidebar structure rather than a
 * separately hand-modeled one. This constant is the repo's canonical copy and
 * the seed the CMS page is created from — keep it in sync with that page.
 *
 * Structure (two tiers):
 * - `## Heading` → small-caps, non-collapsible CATEGORY label that groups
 *   groups (Explore, Guides, What's New, Topics).
 * - `<TopicSection>` / `<SkillsNav>` → collapsible topic groups nested under
 *   the Topics category; collapsed by default, auto-open when a child is active.
 *
 * Authoring notes (component vocabulary, the tutorial-links-are-lists caveat)
 * live in `content-ops/hub-sidebar-seed.mdx` in the project working hub; only
 * the renderable body is embedded here.
 */
export const HUB_SIDEBAR_FALLBACK_MDX = `## Explore

- [Map](/learn)
- [Principles](/principles)
- [Skills](/skills)
- [Tools](/tools)

## Guides

- [LLM Fundamentals](/llm-fundamentals)
- [AI Engineer Roadmap](/ai-engineer-roadmap)
- [AI Coding Dictionary](/ai-coding-dictionary)

<WhatsNew title="What's New" />

## Topics

<TopicSection tag="think-like-an-ai-engineer" label="Think Like an AI Engineer">

- [The AI Engineer Mindset](/the-ai-engineer-mindset)
- [What Is An AI Engineer?](/what-is-an-ai-engineer)
- [My 7 Phases Of AI Development](/my-7-phases-of-ai-development)
- [9 Ways AI Coding Has Rewired My Brain](/ways-ai-coding-has-rewired-my-brain)
- [Personal software is INSANE in the age of AI](/personal-software-is-insane-in-the-age-of-ai-u2hx2)
- [Anthropic thinks you should build agents like this](/building-effective-agents)
- [Google's Introduction To Agents Is GREAT](/google-agents-whitepaper-review)

</TopicSection>

<TopicSection tag="learn-how-llms-think" label="Learn How LLMs Think">

- [What Is An LLM?](/what-is-an-llm)
- [What Are Tokens?](/what-are-tokens)
- [What Is The Context Window?](/what-is-the-context-window)
- [Messages, System Prompts and Reasoning Tokens](/messages-system-prompts-and-reasoning-tokens)
- [What Can You Use LLM's For?](/what-are-llms-used-for)
- [What Is An Agent?](/what-is-an-agent)
- [What Are Tools?](/what-are-tools)
- [5 Questions To Ask Before Choosing An LLM](/how-to-choose-an-llm)
- [Here's 2024's best resource on prompt engineering](/the-prompt-report)

</TopicSection>

<TopicSection tag="set-up-your-agent" label="Set Up Your Agent">

- [A Complete Guide To AGENTS.md](/a-complete-guide-to-agents-md)
- [My AGENTS.md file for building plans you actually read](/my-agents-md-file-for-building-plans-you-actually-read)
- [Creating The Perfect Claude Code Status Line](/creating-the-perfect-claude-code-status-line)
- [How To Use Claude Code Hooks To Enforce The Right CLI](/how-to-use-claude-code-hooks-to-enforce-the-right-cli)
- [This Hook Stops Claude Code Running Dangerous Git Commands](/this-hook-stops-claude-code-running-dangerous-git-commands)
- [Never Run Claude /init](/never-run-claude-init)
- [An Introduction To Plan Mode](/plan-mode-introduction)
- [Connect Claude Code To A GitHub MCP Server](/connect-claude-code-to-github)
- [How To Make Codebases AI Agents Love](/how-to-make-codebases-ai-agents-love)

</TopicSection>

<TopicSection tag="score-first-wins" label="Score First Wins">

- [Real-world feature build with Claude Code: every step explained](/real-world-feature-build-with-claude-code)
- [5 Agent Skills I Use Every Day](/5-agent-skills-i-use-every-day)
- [Essential AI Coding Feedback Loops For TypeScript Projects](/essential-ai-coding-feedback-loops-for-type-script-projects)

</TopicSection>

<TopicSection tag="get-better-results" label="Get Better Results">

- [grill-me: Stress-Test a Plan Before You Build](/skills-grill-me)
- [grill-with-docs: Align Before You Build](/grill-with-docs)
- [9 Things People Get Wrong With /grill-me and /grill-with-docs](/things-people-get-wrong-with-grill-me-and-grill-with-docs)
- [My 'Grill Me' Skill Went Viral](/my-grill-me-skill-has-gone-viral)
- [handoff: Move Context Between Agent Sessions](/skills-handoff)

</TopicSection>

<TopicSection tag="build-the-right-thing" label="Build the Right Thing">

- [to-prd: Turn Resolved Context Into a PRD](/skills-to-prd)
- [to-issues: Break a PRD Into Vertical-Slice GitHub Issues](/skills-to-issues)
- [triage: Turn Backlog Mess Into Agent-Ready Work](/burn-through-your-backlog-with-my-triage-skill)
- [prototype: Answer Questions With Throwaway Code](/skills-prototype)

</TopicSection>

<TopicSection tag="ship-solid-code" label="Ship Solid Code">

- [tdd: Red, Green, Refactor for Agentic Coding](/skills-tdd)
- [My Skill Makes Claude Code GREAT At TDD](/skill-test-driven-development-claude-code)
- [Tracer Bullets: Keeping AI Slop Under Control](/tracer-bullets)
- [improve-codebase-architecture: Find Deepening Opportunities](/skills-improve-codebase-architecture)

</TopicSection>

<TopicSection tag="build-a-software-factory" label="Build a Software Factory">

- [Getting Started With Ralph](/getting-started-with-ralph)
- [Here's How To Stream Claude Code With AFK Ralph](/heres-how-to-stream-claude-code-with-afk-ralph)
- [11 Tips For AI Coding With Ralph Wiggum](/tips-for-ai-coding-with-ralph-wiggum)
- [Why the Anthropic Ralph plugin sucks (use a bash loop instead)](/why-the-anthropic-ralph-plugin-sucks)

</TopicSection>

<TopicSection tag="meta-announcements" label="Meta">

- [My Claude Code Cohort - A Teaser](/my-claude-code-cohort-a-teaser)
- [2025: The Year Building With GenAI's Gets Boring](/2025-the-year-building-with-gen-ais-gets-boring~d53hd)

</TopicSection>
`
