# C5 CTA coverage, sweep 2

Baseline: `cc3aa382` (PR #490). All additions use `C5SaleSwitch`, which preserves the old surface when C5 pricing is closed or the enrollment window ends at `2026-11-10T07:30:00Z`. No flag, CMS, database, Redis or commerce configuration changes are required.

## Route audit

The global banner is excluded from this table. “Already covered” means an in-page placement from PR #490, not navigation or footer promotion.

| Route | Before | After |
| --- | --- | --- |
| `/ai-coding-dictionary/*` | Entry body, previous/next navigation, newsletter. No in-page C5 ask. | One `C5SaleCta` after the entry body, before entry navigation. |
| `/ai-coding-dictionary` | Searchable dictionary catalog and newsletter. No in-page C5 ask. | One `C5SaleCta` after the catalog. |
| `/q` | Search interface. No in-page C5 ask. | One `C5SaleCta` below search. |
| `/skills/subscribe` | Free email-course signup and subscriber states. | Same signup; quiet secondary cohort link below it. |
| `/courses` | Offer ladder and `CohortHero`; its C5 switch replaces the cohort ask during enrollment. | Already covered. No extra card. |
| `/` | Landing hero's C5 switch and existing cohort section. | Already covered. No extra card. |
| `/newsletter` | Newsletter form or subscriber confirmation. | Same form; quiet secondary cohort link below it. |
| `/cohorts/ai-coding-for-real-engineers-m0k0w` | Old cohort content and ownership-dependent curriculum/purchase rail. No C5 callout. | Closed-cohort callout above the content and in the buy rail, for visitors and alumni. |
| `/cohorts/claude-code-for-real-engineers-2026-04` | Same shared cohort template, no C5 callout. | Same two callouts. |
| `/cohorts/build-your-own-ai-personal-assistant-in-typescript` | Same shared cohort template, no C5 callout. | Same two callouts. |
| `/cohorts/build-deepsearch-in-typescript` | Same shared cohort template, no C5 callout. | Same two callouts. |
| `/skills` | Skills catalog, sales copy, changelog and GitHub section; bypasses post-body placement. | One `C5SaleCta` after the sales copy. |
| `/skills-grill-me` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-setup-matt-pocock-skills` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-grill-with-docs` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-wayfinder` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-improve-codebase-architecture` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-pr` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-to-spec` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-ask-matt` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-to-tickets` | Free course ask plus one C5 post-body card. | Already covered. |
| `/skills-handoff` | Free course ask plus one C5 post-body card. | Already covered. |
| `/workshops/ai-coding-crash-course` | `C5SaleSwitch` and `C5SaleCta` above the workshop hero, outside ownership/pricing branches. | Already covered for non-owners (and owners). No checkout changes. |
| `/posts` | Searchable post graph, bypasses post-body placement. | One `C5SaleCta` below search. |
| `/llm-fundamentals` | Root slug resolves to shared list landing, not an article. No C5 ask. | One end-of-page `C5SaleCta` in shared `ListPage`. |
| `/ai-engineer-roadmap` | Root slug resolves to shared list landing, not an article. No C5 ask. | Same list placement. |
| `/vercel-ai-sdk-tutorial` | Root slug resolves to shared list landing, not an article. No C5 ask. | Same list placement. |
| `/model-context-protocol-tutorial` | Root slug resolves to shared list landing, not an article. No C5 ask. | Same list placement. |
| `/learn` | Goal map and recent content. No in-page C5 ask. | One `C5SaleCta` after the map. |
| Other article posts using `PostBody` | PR #490 could turn both an inline course callout and the end card into C5 asks. | End card owns the C5 ask. Inline course callouts render their original content only outside the campaign. Explicit editorial `cta: none` behavior stays unchanged. |

The four root list routes and ten named skill posts were checked with anonymous public GETs during the audit: all returned 200. Each skill page had one tracked C5 in-page link; each list landing had none and rendered the shared “Start lesson 1” control. The remaining rows were traced through their route/component source. No production mutations or preview payment tests were run.

## Responsive banner

`Promo.shortMessage` is optional. Both messages are server-rendered and CSS selects the short message below `sm`, full message from `sm` up. The optional badge is hidden below `sm` only when short copy exists, leaving room for the complete message and arrow. The Crash Course keeps its existing message, badge and markup path.

- Full: “Software Factories for Real Engineers: enrollment is open.”
- Mobile: “Software Factories cohort: enrollment open”
- Chromium, real app CSS and local DM Sans Medium: mobile text width 257.875px, one 17.5px line at both 360px and 390px, bar height 34px. No clipping or overflow in light or dark mode.
- At 1024px, the full message is visible and the mobile message is hidden.

## Verification

- Targeted Vitest run: 44 tests pass across seven files, including the opt-in Chromium geometry test.
- `pnpm typecheck`: passes, including prerequisite workspace builds. Final native TypeScript check also passes after adding the browser test.
- Changed-file ESLint: passes.
- App-wide `pnpm lint`: fails on 19 errors in untouched `sidebar-sections.tsx` and `video-facts.ts`, plus 46 warnings.
- Full `pnpm test --reporter=dot`: 735 files pass, four fail, 41 skip. 8,626 tests pass, five fail, 638 skip. Failures are in untouched suites: missing logger mock export in `compile-mdx-office-hours-cache`, missing middleware `onFailure` hook, discovery operation count 67 versus 65, and two `SkillsHero` tests requiring a Cloudinary cloud name. The opt-in browser check is one of the default skips and was run separately above.
- `git diff --check`: passes.

Run the browser check without an app server:

```sh
cd apps/ai-hero
AIH_BROWSER_CHECK=1 pnpm exec vitest run -c vitest.config.ts src/components/navigation/promo-bar-content.browser.test.tsx
```

## Review and rollout

Keep this change in a draft PR. Review the old cohort top and buy rail as both an anonymous visitor and an alumnus. Existing owner content/access remains untouched; the new callout has no ownership gate. Check the two signup pages still lead with their forms. Check a dictionary entry, list landing, skill post and ordinary article each have only one in-page C5 card.

No new switch is introduced. Existing server/client C5 switches supply the time window and pricing-close behavior. Closing the existing switch hides the additions; reopening is an operator decision. Outside the window, the inline article callout returns unchanged. Code rollback is a revert of this commit.

### Draft heads-up for the owning team, not sent

The draft adds C5 links to dictionary, search, tutorial, skills and learning pages, plus callouts on past cohort pages. Signup forms stay primary, and the promo bar now has short mobile copy; window/switch tests and phone-width browser checks cover the temporary placements.
