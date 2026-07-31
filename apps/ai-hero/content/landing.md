{/*
  LOCAL MIRROR of the CMS page `landing-page-v2` (type: page, published +
  unlisted). NOT the source of truth: `src/app/page.tsx` loads the body from
  the DB at runtime. Kept in sync for diffing and review only. After editing
  here, PUT the body to the CMS (docs/landing-mdx-components.md §API).

  COPY UPDATED against `AI Hero Courses Redesign/Home Page.dc.html`. Needs
  Matt's sign-off before it goes to the CMS. The two moves that change what the
  page argues:

  1. The manifesto's line is now the HERO headline ("Engineering fundamentals
     aren't obsolete"), so the page leads with the claim instead of burying it
     three sections down.
  2. The manifesto opens on the cost ("Bad code is now the most expensive it
     has ever been"), which is the sentence the rest of the section proves.

  Em dashes from the prototype are commas here (DESIGN.md § Bans).
*/}

<Hero
	h1="Engineering fundamentals aren't obsolete."
	h2="They're your biggest advantage. AI Hero is the engineering process for working with coding agents, from an idea to shipped, reviewed code."
/>

<Manifesto headline="Bad code is now the most expensive it has ever been.">

A lot of people think the rules of software development are being rewritten by AI. They think that code is cheap. That software engineering, as a discipline, is finished.

Coding agents like Claude Code and Codex ship code faster than any human ever has. But without careful guidance, they make codebases worse. And the worse the codebase, the worse the AI performs. It's a vicious circle.

If you can design codebases agents love, you can reap the rewards of this new era. AI Hero is for anyone who cares about the code they ship.

</Manifesto>

<SkillsShowcase
	heading="A real engineering process, as installable skills"
	intro="Every skill here is free, installs in one command, and you can use it today. Start anywhere. Most people start with the main flow."
/>

{/*
  Wireframe § ⑤ wants an "updated skills overview" here, NOT the roadmap (the
  roadmap already appears in the activity ladder below, and Amy's slot is about
  the skills workflow the section just explained). Her note: "Matt should create
  an updated version of '5 Agent Skills I Use Every Day' — the current one is
  outdated." Pointing at that post until the refreshed one exists.
*/}

{/*
<Resource slugOrId="5-agent-skills-i-use-every-day" badge="Start here" />
<Resource slugOrId="llm-fundamentals" />
<Resource slugOrId="ai-sdk-v6-crash-course" />
<Resource slugOrId="model-context-protocol-tutorial" />
*/}

{/*
  Rungs are four of the hub sidebar's own topic groups, in the sidebar's order
  (`hub-sidebar-fallback.ts`) — that ordering is already a curriculum arc, so
  the homepage borrows it rather than inventing a fifth taxonomy. Four of the
  eight, not all: these are the groups with real depth (4 to 9 published posts
  behind each `moreHref`) and no overlap with each other.

  `audience` carries the sidebar's label so the two surfaces name the same
  thing; the heading asks the question the reader actually has.

  Deliberately skipped: "Build the Right Thing" and "Get Better Results" are
  almost entirely skills, which the section above already covers, and "Score
  First Wins" is three posts that all appear elsewhere on this page.

  Picks avoid the "Latest posts" grid below, so nothing appears twice.
*/}

<ActivityLadder
	heading="What do you want to do?"
	intro="Most developers find the gap is further back than they expected. Pick the honest one."
	ctaHref="/learn"
	ctaLabel="See the full map"
>
	<ActivityRung
		audience="Learn how LLMs think"
		question="What is actually happening when I prompt a model?"
		moreHref="/topics/learn-how-llms-think"
		moreLabel="More on how LLMs think"
	>
		<Resource slugOrId="what-is-an-llm" variant="ladder" />
		<Resource slugOrId="what-is-the-context-window" variant="ladder" />
		<Resource slugOrId="what-are-tokens" variant="ladder" />
	</ActivityRung>
	<ActivityRung
		audience="Set up your agent"
		question="How do I get it working the way I work?"
		moreHref="/topics/set-up-your-agent"
		moreLabel="More ways to set up your agent"
	>
		<Resource slugOrId="a-complete-guide-to-agents-md" variant="ladder" />
		<Resource slugOrId="plan-mode-introduction" variant="ladder" />
		<Resource slugOrId="never-run-claude-init" variant="ladder" />
	</ActivityRung>
	<ActivityRung
		audience="Ship solid code"
		question="How do I ship code I would put my name on?"
		moreHref="/topics/ship-solid-code"
		moreLabel="More on shipping solid code"
	>
		<Resource slugOrId="skill-test-driven-development-claude-code" variant="ladder" />
		<Resource slugOrId="skills-improve-codebase-architecture" variant="ladder" />
		<Resource slugOrId="essential-ai-coding-feedback-loops-for-type-script-projects" variant="ladder" />
	</ActivityRung>
	<ActivityRung
		audience="Build a software factory"
		question="How far can I let an agent run on its own?"
		moreHref="/topics/build-a-software-factory"
		moreLabel="More on running agents unattended"
	>
		<Resource slugOrId="getting-started-with-ralph" variant="ladder" />
		<Resource slugOrId="heres-how-to-stream-claude-code-with-afk-ralph" variant="ladder" />
		<Resource slugOrId="tips-for-ai-coding-with-ralph-wiggum" variant="ladder" />
	</ActivityRung>
</ActivityLadder>

{/*
  The cohort sits ABOVE the proof, not after it. It is the one thing on this
  page a reader can buy, and behind the ladder + three testimonials it was the
  ninth block down. The quotes now do what quotes are for: they back up the
  offer the reader has just been made, rather than arriving before there is an
  offer to back.
*/}

<UpcomingCohort />

{/*
  The shadcn quote is DELIBERATELY CLIPPED, and confirmed. The full tweet
  frames Matt as tracking every model release, which Alex flagged and Matt
  agreed was not how he sees himself ("[aih] Banger testimonial from high-trust
  dev", Jun 24); the agreed use is this line alone. Do NOT "restore" the full
  quote. Source: x.com/shadcn/status/2069746957292130319.

  All three quotes now sit in one PROOF block rather than being spent one at a
  time down the page — three recognisable names read together are an argument,
  the same three a screenful apart are decoration.
*/}

<ProofGrid>

<ProofQuote authorName="Guillermo Rauch" authorTitle="Vercel CEO" authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1737463838/workshops/page-6z2ir/qxwhr72flnhn571y4cvg.jpg">
Matt is one of the best developer educators in the world.
</ProofQuote>

<ProofQuote authorName="shadcn" authorTitle="Creator of shadcn/ui" authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1785230951/aihero/testimonials/shadcn.jpg">
Every company needs its own Matt Pocock.
</ProofQuote>

<ProofQuote authorName="Mario Zechner" authorTitle="Creator of Pi" authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1785230951/aihero/testimonials/mario-zechner.jpg">
Matt Pocock is a true educator and I admire how he brings structure to this mess we are in.
</ProofQuote>

</ProofGrid>

<SectionHeader heading="Latest posts and videos" linkHref="/posts" linkLabel="See more in the blog" />

<ResourceGrid>
	<Resource slugOrId="skills-changelog-ubiquitous-language-grill-with-docs" variant="card" />
	<Resource slugOrId="my-grill-me-skill-has-gone-viral" variant="card" />
	<Resource slugOrId="real-world-feature-build-with-claude-code" variant="card" />
	<Resource slugOrId="tracer-bullets" variant="card" />
	<Resource slugOrId="how-to-make-codebases-ai-agents-love" variant="card" />
	<Resource slugOrId="things-people-get-wrong-with-grill-me-and-grill-with-docs" variant="card" />
</ResourceGrid>

{/*
  ONE newsletter on the page, and it lives here (`Home Page.dc.html` § MATT +
  NEWSLETTER). The mid-page block and the slim end-of-page strip are both
  gone: they made the same ask twice, at two volumes, neither of them next to
  the person making it.

  main added a course-pointed block in this slot (`point homepage signup at
  skills course`). Not reinstated: that change was about WHICH offer the
  homepage asks for, and the block below already asks for the course. Putting
  it back would restore the double ask this section removed.
*/}

<AboutMatt
	headline="Hi, I'm Matt Pocock"
	newsletter={<NewsletterSection heading={<>Join <SubscriberCount /> developers learning to code with AI</>} subTitle="Start with the free email course: seven lessons, tied to real work, with a repeatable agent workflow at the end."><CourseCta /></NewsletterSection>}
>

Before creating AI Hero, I created Total TypeScript, the industry standard course for learning TS. I was a member of the XState core team, and a developer advocate at Vercel.

I'm building AI Hero to make the secrets of the AI Engineer available to everyone.

</AboutMatt>
