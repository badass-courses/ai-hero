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
	h1="**Real**<br />Engineering<br />with AI"
	h2="Engineering fundamentals aren't obsolete. They're essential."
/>

<Manifesto headline="Engineering fundamentals are your biggest advantage.">

A lot of people think the rules of software development are being rewritten by AI. They think that code is cheap. That software engineering, as a profession, is finished.

Coding agents like Claude Code and Codex ship code faster than any human ever has. But without careful guidance, they make codebases worse. And the worse the codebase, the worse the AI performs. It's a vicious circle.

Code isn't cheap. In fact, bad code is the most expensive it's ever been. If you can design codebases agents love, you can reap the rewards of this new era.

Software fundamentals aren't obsolete. They're essential. AI Hero is for anyone who cares about the code they ship.

</Manifesto>

<NewsletterSection heading={<>Join <SubscriberCount /> developers</>} subTitle="Notes on what actually works with AI coding agents, straight to your inbox."><NewsletterCta /></NewsletterSection>

## Level up your coding practice with **Real AI Engineering**

<SkillsShowcase
	intro="I've built an engineering process for working with AI coding agents, from grilling an idea to shipping reviewed code. Every skill here is free, installs in one command, and you can use it today."
/>

{/*
  Wireframe § ⑤ wants an "updated skills overview" here, NOT the roadmap (the
  roadmap already appears in the topics grid below, and Amy's slot is about the
  skills workflow the section just explained). Her note: "Matt should create an
  updated version of '5 Agent Skills I Use Every Day' — the current one is
  outdated." Pointing at that post until the refreshed one exists.
*/}

<Resource slugOrId="5-agent-skills-i-use-every-day" badge="Start here" />

{/*
  PARKED — the wireframe's section order lists only the "Start here" resource
  here. These three kept a homepage slot in v1; whether they return, move into
  TopicsGrid, or drop is blocked on Matt/Amy. Restore by uncommenting.

  <Resource slugOrId="llm-fundamentals" />
  <Resource slugOrId="ai-sdk-v6-crash-course" />
  <Resource slugOrId="model-context-protocol-tutorial" />
*/}

{/*
  Wording confirmed. Source: x.com/badlogicgames/status/2075329079931212197.
  Avatar from github.com/badlogic (Twitter handle on that profile is
  badlogicgames, which is how the identity was verified), uploaded to
  Cloudinary rather than hotlinked.
*/}

<TestimonialDivider
	authorName="Mario Zechner — creator of Pi"
	authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1785230951/aihero/testimonials/mario-zechner.jpg"
>

Matt Pocock is a true educator and I admire how he brings structure to this mess we are in.

</TestimonialDivider>

<TopicsGrid>
	<TopicsGridColumn heading="Ship better code" moreHref="/topics/ship-solid-code">
		<Resource slugOrId="skill-test-driven-development-claude-code" variant="list" />
		<Resource slugOrId="tracer-bullets" variant="list" />
		<Resource slugOrId="how-to-make-codebases-ai-agents-love" variant="list" />
	</TopicsGridColumn>
	<TopicsGridColumn heading="Understand AI fundamentals" moreHref="/topics/understand-the-basics">
		<Resource slugOrId="what-is-an-ai-engineer" variant="list" />
		<Resource slugOrId="what-are-llms-used-for" variant="list" />
		<Resource slugOrId="ai-engineer-roadmap" variant="list" />
	</TopicsGridColumn>
	<TopicsGridColumn heading="Level up your workflow" moreHref="/topics/level-up-your-workflow">
		<Resource slugOrId="ways-ai-coding-has-rewired-my-brain" variant="list" />
		<Resource slugOrId="real-world-feature-build-with-claude-code" variant="list" />
		<Resource slugOrId="things-people-get-wrong-with-grill-me-and-grill-with-docs" variant="list" />
	</TopicsGridColumn>
</TopicsGrid>

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

## My latest posts/videos

<ResourceGrid>
	<Resource slugOrId="skills-changelog-ubiquitous-language-grill-with-docs" variant="card" />
	<Resource slugOrId="my-grill-me-skill-has-gone-viral" variant="card" />
	<Resource slugOrId="real-world-feature-build-with-claude-code" variant="card" />
	<Resource slugOrId="tracer-bullets" variant="card" />
	<Resource slugOrId="how-to-make-codebases-ai-agents-love" variant="card" />
	<Resource slugOrId="things-people-get-wrong-with-grill-me-and-grill-with-docs" variant="card" />
</ResourceGrid>

<SectionLink href="/posts">See more in my blog</SectionLink>

<NewsletterSection compact heading="Get the next one in your inbox" subTitle="New posts and skills as I publish them."><NewsletterCta /></NewsletterSection>

<Testimonial authorName="Guillermo Rauch — Vercel CEO" authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1737463838/workshops/page-6z2ir/qxwhr72flnhn571y4cvg.jpg">

“Matt is one of the best developer educators in the world.”

</Testimonial>

<AboutMatt headline="Hi, I'm Matt Pocock">

Before creating AI Hero, I created Total TypeScript - the industry standard course for learning TS.

I was a member of the XState core team, and was a developer advocate at Vercel.

I'm building AI Hero to make the secrets of the AI Engineer available to everyone.

</AboutMatt>
