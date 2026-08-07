# AGENTS.md, ai-hero

## LAUNCH MODE: AI Coding Crash Course campaign, 2026-08-07 to 2026-08-25

An active launch campaign is in flight. Every agent session in this repo (claude, codex, pi) works launch-aware until the August 25 post-launch review removes this block.

- Source of truth: `.brain/projects/ai-coding-crash-course-launch/ai-coding-crash-course-launch-brief.svx` in the aihero-support repo (`/Users/joel/Code/badass-courses/aihero-support`).
- Doors open August 17. Intro price $199 until August 24. Pricing, offer, and coupon configuration changes need explicit operator approval and a live readback.
- Kit sequence `2625552` (AI Hero Shadow Newsletter) is deliberately paused for the campaign. Do not reactivate it, and do not treat its 400 subscribe errors as an outage or a bug to fix. The entry function `ai-hero-skills-newsletter-path-entry-v2` tags affected signups with Kit tag `22309615` (`aih-shadow-newsletter-backfill`) for a post-campaign backfill.
- Deploys to main reach a live launch funnel doing roughly 700 signups per day. Keep changes small, verified, and reversible. Any new failure class in Inngest, checkout, or signup paths escalates immediately; the known learner-flow shadow-newsletter deferral does not.
- Agent-authored commits and pushes go through shitrat tooling as `shitratgit[bot]`.

Remove this block at the August 25 review, see `review-shadow-newsletter-after-campaign.svx` in the same Brain project.
