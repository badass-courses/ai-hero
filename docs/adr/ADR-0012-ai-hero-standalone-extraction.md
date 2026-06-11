# ADR-0012: Extract apps/ai-hero to Standalone Repository

**Status:** Accepted
**Date:** 2026-06-11
**Decider:** Joel Hooks

---

## Context

`apps/ai-hero` is a high-velocity production app living inside `badass-courses/course-builder`, a pnpm monorepo that also hosts 13 other apps. As ai-hero matured and accelerated, monorepo membership imposed growing overhead:

- **CI time:** Full-monorepo CI runs include unrelated apps, inflating wait times for ai-hero-only changes.
- **Lockstep releases:** Shared lockfile and workspace protocol references mean a dependency bump in one app can surface conflicts across all apps.
- **Cross-app entanglement:** Workspace `*` references make it easy to accidentally couple ai-hero to packages that aren't production-stable in isolation.
- **Blast radius:** A bad merge to `main` in the monorepo can block deploys for all tenants simultaneously.

The egghead extraction (ADR-0011 pattern, executed 2026-06-11) proved the model: excise the app directory, pin all workspace deps to specific npm versions, repoint the Vercel project, and run independently. CI scope dropped; release cadence became self-owned. ai-hero is the next app that meets the maturity and velocity threshold.

---

## Decision

Extract `apps/ai-hero` from `badass-courses/course-builder` into a dedicated repository at `badass-courses/ai-hero`, structured as an independent turborepo.

**Key mechanics:**

1. **Git history preserved** — the new repo is initialized from the extracted subtree (or equivalent initial commit) so blame and history travel with the code.
2. **Workspace deps pinned** — all `workspace:*` references are replaced with locked npm version strings at the time of extraction. No floating workspace protocol in the standalone repo.
3. **Monorepo app frozen** — `apps/ai-hero` in `course-builder` is left in place as a read-only archive for a soak period (no new PRs merged). A deletion PR removes it after the soak period passes and production confirms the new repo is healthy.
4. **Vercel project repointed** — the existing Vercel project is updated to track `badass-courses/ai-hero`. Environment variables are preserved; no new project is created.
5. **pnpm workspace config** — the standalone repo uses `pnpm-workspace.yaml` for any overrides (pnpm v11 ignores `pnpm.overrides` in `package.json`).

---

## Consequences

### Immediate

- **Faster CI** — pipelines scope to ai-hero only; no monorepo-wide turbo graph overhead.
- **Independent release cadence** — deploys, dependency bumps, and breaking changes are ai-hero's problem alone.
- **Isolated blast radius** — a bad commit in `course-builder` cannot block ai-hero deploys.
- **Env var continuity** — Vercel preserves all secrets and env vars on project repoint; no re-entry required.

### Short-term

- **Frozen archive** — `apps/ai-hero` in `course-builder` accumulates no new changes. Contributors must direct PRs to the new repo. The archive is a safety net, not a working copy.
- **Dependency drift** — pinned versions will fall behind. ai-hero owns its upgrade schedule; no monorepo forces alignment.

### Long-term

- **Pattern replication** — other mature, high-velocity apps in `course-builder` may follow this extraction pattern when they hit the same threshold (dedicated repo, pinned deps, independent CI).
- **Monorepo scope narrows** — `course-builder` retains shared packages, lower-velocity apps, and demos. High-velocity products extract. This is the intended topology.

---

## Alternatives Considered

| Alternative | Rejected because |
|---|---|
| Stay in monorepo, improve CI caching | Addressed symptoms, not root cause; cross-app entanglement risk remains |
| Nx remote cache or Turborepo remote cache | Helps CI time but doesn't eliminate lockstep release coupling |
| Separate pnpm workspace in same repo | Doesn't eliminate blast radius; still one lockfile |
| Full git subtree split with ongoing sync | Sync overhead defeats the point; clean cut is simpler |

---

## References

- ADR-0011: egghead standalone extraction (course-builder docs)
- [pnpm v11 workspace overrides note](../memory/pnpm-v11-workspace-overrides.md)
- Vercel project repoint docs: https://vercel.com/docs/git/monorepos
