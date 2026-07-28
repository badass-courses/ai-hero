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
	h1="Become a<br />**Real** AI Hero"
	h2="with Matt Pocock"
/>

<Manifesto headline="Most AI engineering isn't engineering yet.">

There's a class of code that ships to production, and a class that lives on someone's laptop in a notebook. The line between them isn't how impressive the demo is. It's evals, observability, and the boring infrastructure that makes a system answerable to its bug reports.

Real AI Engineering is the part nobody tweets about. Prompts that fail loudly. Retrieval that you can debug. Models you can swap out. Tests that run on every commit. Logs you actually read.

This site is for engineers who want to learn to build that — and stop pretending the rest of it doesn't matter.

</Manifesto>

<NewsletterCta />

## Level up your coding practice with **Real AI Engineering**

<SkillCycleSection ctaHref="/skills" ctaLabel="See all skills" />

<Resource slugOrId="ai-engineer-roadmap" badge="Start here" />

{/*
  PARKED — the wireframe's section order lists only the "Start here" resource
  here. These three kept a homepage slot in v1; whether they return, move into
  TopicsGrid, or drop is blocked on Matt/Amy. Restore by uncommenting.

  <Resource slugOrId="llm-fundamentals" />
  <Resource slugOrId="ai-sdk-v6-crash-course" />
  <Resource slugOrId="model-context-protocol-tutorial" />
*/}

<TestimonialDivider authorName="Placeholder — real quote pending">

PLACEHOLDER: a short line about the skills workflow, to be replaced with a real quote before launch.

</TestimonialDivider>

<TopicsGrid>
	<TopicsGridColumn heading="Think like an AI engineer" moreHref="/topics/think-like-an-ai-engineer">
		<Resource slugOrId="the-ai-engineer-mindset" variant="list" />
		<Resource slugOrId="what-is-an-ai-engineer" variant="list" />
		<Resource slugOrId="my-7-phases-of-ai-development" variant="list" />
	</TopicsGridColumn>
	<TopicsGridColumn heading="Learn how LLMs think" moreHref="/topics/learn-how-llms-think">
		<Resource slugOrId="what-is-an-llm" variant="list" />
		<Resource slugOrId="what-are-tokens" variant="list" />
		<Resource slugOrId="what-is-the-context-window" variant="list" />
	</TopicsGridColumn>
	<TopicsGridColumn heading="Set up your agent" moreHref="/topics/set-up-your-agent">
		<Resource slugOrId="a-complete-guide-to-agents-md" variant="list" />
		<Resource slugOrId="plan-mode-introduction" variant="list" />
		<Resource slugOrId="connect-claude-code-to-github" variant="list" />
	</TopicsGridColumn>
</TopicsGrid>

<TestimonialDivider authorName="Placeholder — real quote pending">

PLACEHOLDER: a short line about the cohort, to be replaced with a real quote before launch.

</TestimonialDivider>

## Go further on a **live cohort**

<UpcomingCohort />

## My latest posts/videos

<ResourceGrid>
	<Resource slugOrId="skills-changelog-ubiquitous-language-grill-with-docs" variant="card" />
	<Resource slugOrId="my-grill-me-skill-has-gone-viral" variant="card" />
	<Resource slugOrId="real-world-feature-build-with-claude-code" variant="card" />
	<Resource slugOrId="5-agent-skills-i-use-every-day" variant="card" />
	<Resource slugOrId="how-to-make-codebases-ai-agents-love" variant="card" />
	<Resource slugOrId="tracer-bullets" variant="card" />
</ResourceGrid>

<NewsletterSection heading="Get the next one in your inbox" subTitle={<>Join over <SubscriberCount /> developers becoming AI Heroes</>}><NewsletterCta /></NewsletterSection>

<Testimonial authorName="Guillermo Rauch — Vercel CEO" authorAvatar="http://res.cloudinary.com/total-typescript/image/upload/v1737463838/workshops/page-6z2ir/qxwhr72flnhn571y4cvg.jpg">

“Matt is one of the best developer educators in the world.”

</Testimonial>

<AboutMatt headline="Hi, I'm Matt Pocock">

Before creating AI Hero, I created Total TypeScript - the industry standard course for learning TS.

I was a member of the XState core team, and was a developer advocate at Vercel.

I'm building AI Hero to make the secrets of the AI Engineer available to everyone.

</AboutMatt>
