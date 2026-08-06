{/*
  LOCAL MIRROR of the CMS page `skills-for-your-team` (id: page-kq7we).
  NOT the source of truth: `src/app/(content)/skills/for-your-team/page.tsx`
  loads the body from the DB at runtime, so edits here change nothing until
  they are PUT back to /api/pages. Kept for diffing and review.

  Copy is Alex's landing-page outline from the launch doc (§ "AI Skills for
  Real Engineering Teams"), set into the page's blocks. Em dashes from the
  outline are commas here (DESIGN.md § Bans).

  TWO THINGS FOR MATT, both editable from /admin/pages without a deploy:

  1. THE VIDEO. Upload the deck recording in the editor, then put its resource
     id in the <Video /> tag inside <TeamHero> and delete the comment around
     it. Until then the hero draws a striped placeholder, which is a designed
     state, not a broken one.
  2. THE SLIDES. Add href="…" to <SlidesCard> once the deck file is uploaded.
     The download button appears as soon as the href is there.
*/}

<TeamHero
	h1="Bring Real Engineering to your team, with my AI skills."
	lead="Pull it up on a screen and watch together, or send it round and watch on your own time. It is the engineering process I use with coding agents, and the free, open source skills that put that process in your codebase."
>

{/* <Video resourceId="PASTE_VIDEO_RESOURCE_ID_HERE" /> */}

</TeamHero>

{/* The running order and the slides aside sit side by side from 900px up. */}

<TeamSplit>

<LearnList
	heading="What your team will take away"
	intro="One sitting, and everyone comes out with the same picture of how coding agents actually work and how to get consistent results from them."
>

{/* Matt, doc comment 2026-08-06: don't push the danger angle too hard, people
    are already aware of it in the current news cycle. Reframed to lead with
    the reward and treat the risk as the thing the process handles. */}

<LearnItem>What coding agents genuinely buy you, and what they need from you in return.</LearnItem>

<LearnItem>Why code quality is now an agent-performance problem, not just a product one.</LearnItem>

<LearnItem>The three agentic coding failure types, and the fix for each one.</LearnItem>

<LearnItem>How context and skills actually work, explained simply.</LearnItem>

<LearnItem>The easiest way for anyone, programmer or not, to get started: grill me, then implement.</LearnItem>

{/* Matt's own wording, doc comment 2026-08-06. */}

<LearnItem>How to do work larger than one context window.</LearnItem>

<LearnItem>A preview of the skills themselves, including improve-codebase-architecture.</LearnItem>

</LearnList>

<SlidesCard
	heading="Prefer to present it yourself?"
	body="If you are a do-it-yourselfer, take my slides and run the session with your own team, in your own words."
/>

</TeamSplit>

{/* Alex's two paragraphs from the launch doc, merged into one.

    They were split across the band's body and the form's prompt, which made
    the close read as two blocks with a form stuck to the end. Merged, the
    paragraph carries all four of Alex's facts — what it is, when it lands,
    best price, team rates — and ends on the ask, so the fields underneath
    finish the sentence instead of restating it.

    Em dashes and the ellipsis are commas and full stops here (DESIGN.md § Bans). */}

<TeamClose heading="Keep learning together">

<TeamCloseBody>
If you want to learn more, faster, and together, you're going to love my upcoming AI Coding Crash Course, out in just a couple of weeks. Drop your info here and I'll email you the moment you can **buy it at the best price, with special rates for teams**.
</TeamCloseBody>

<TeamCta />

</TeamClose>
