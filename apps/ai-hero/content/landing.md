{/*
  LOCAL MIRROR of the CMS page `landing-page-v2` (type: page, published +
  unlisted). NOT the source of truth: `src/app/page.tsx` loads the body from
  the DB at runtime. Kept in sync for diffing and review only. After editing
  here, PUT the body to the CMS (docs/landing-mdx-components.md §API).

  PLACEHOLDER copy is marked inline. Blocked on Matt/Amy: both testimonial
  divider quotes, and whether the three parked resource rows below keep a
  homepage placement.
*/}

<Hero
	h1="**Real Engineering**<br />with AI"
	h2="Engineering fundamentals aren't obsolete. They're essential."
/>

<Manifesto headline="Engineering fundamentals are your biggest advantage.">

A lot of people think the rules of software development are being rewritten by AI. They think that code is cheap. That software engineering, as a profession, is finished.

Coding agents like Claude Code and Codex ship code faster than any human ever has. But without careful guidance, they make codebases worse. And the worse the codebase, the worse the AI performs. It's a vicious circle.

Code isn't cheap. In fact, bad code is the most expensive it's ever been. If you can design codebases agents love, you can reap the rewards of this new era.

Software fundamentals aren't obsolete. They're essential. AI Hero is for anyone who cares about the code they ship.

</Manifesto>

<SkillsShowcase
	heading="Level up your coding practice with Real AI Engineering"
	intro="I've built an engineering process for working with AI coding agents, from grilling an idea to shipping reviewed code. Every skill here is free, installs in one command, and you can use it today."
/>

{/*
  Wireframe § ⑤ wants an "updated skills overview" here, NOT the roadmap (the
  roadmap already appears in the topics grid below, and Amy's slot is about the
  skills workflow the section just explained). Her note: "Matt should create an
  updated version of '5 Agent Skills I Use Every Day' — the current one is
  outdated." Pointing at that post until the refreshed one exists.
*/}

{/*
<Resource slugOrId="5-agent-skills-i-use-every-day" badge="Start here" />
<Resource slugOrId="llm-fundamentals" />
<Resource slugOrId="ai-sdk-v6-crash-course" />
<Resource slugOrId="model-context-protocol-tutorial" />
*/}


<SplitRow>

<NewsletterSection heading={<>Join <SubscriberCount /> developers learning to code with AI</>} subTitle="Short, practical notes on getting real work out of coding agents. Free, and you can leave whenever you like."><NewsletterCta /></NewsletterSection>

<TestimonialDivider
	compact
	authorName="Mario Zechner — creator of Pi"
	authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1785230951/aihero/testimonials/mario-zechner.jpg"
>

Matt Pocock is a true educator and I admire how he brings structure to this mess we are in.

</TestimonialDivider>

</SplitRow>
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

  Picks avoid the "My latest posts" grid below, so nothing appears twice.
*/}

<ActivityLadder
	heading="What do you want to do?"
	intro="Start where you are. Most developers find the gap is further back than they expected."
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
  DELIBERATELY CLIPPED, and confirmed. The full tweet frames Matt as tracking
  every model release, which Alex flagged and Matt agreed was not how he sees
  himself ("[aih] Banger testimonial from high-trust dev", Jun 24); the agreed
  use is this line alone. Do NOT "restore" the full quote.
  Source: x.com/shadcn/status/2069746957292130319.
*/}

<TestimonialDivider
	authorName="shadcn — creator of shadcn/ui"
	authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1785230951/aihero/testimonials/shadcn.jpg"
>

Every company needs its own Matt Pocock.

</TestimonialDivider>

<UpcomingCohort />

<SectionHeader heading="My latest posts/videos" linkHref="/posts" linkLabel="See more in my blog" />

<ResourceGrid>
	<Resource slugOrId="skills-changelog-ubiquitous-language-grill-with-docs" variant="card" />
	<Resource slugOrId="my-grill-me-skill-has-gone-viral" variant="card" />
	<Resource slugOrId="real-world-feature-build-with-claude-code" variant="card" />
	<Resource slugOrId="tracer-bullets" variant="card" />
	<Resource slugOrId="how-to-make-codebases-ai-agents-love" variant="card" />
	<Resource slugOrId="things-people-get-wrong-with-grill-me-and-grill-with-docs" variant="card" />
</ResourceGrid>

<NewsletterSection compact heading="Get the next one in your inbox" subTitle={<>New posts and skills as I publish them. Join <SubscriberCount /> developers.</>}><NewsletterCta /></NewsletterSection>

<Testimonial authorName="Guillermo Rauch — Vercel CEO" authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1737463838/workshops/page-6z2ir/qxwhr72flnhn571y4cvg.jpg">

Matt is one of the best developer educators in the world.

</Testimonial>

<AboutMatt headline="Hi, I'm Matt Pocock">

Before creating AI Hero, I created Total TypeScript - the industry standard course for learning TS.

I was a member of the XState core team, and was a developer advocate at Vercel.

I'm building AI Hero to make the secrets of the AI Engineer available to everyone.

</AboutMatt>
