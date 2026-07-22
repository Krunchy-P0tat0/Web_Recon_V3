# Web_Recon_V3 — Project Plan

_This document is the authoritative roadmap. Consult PROJECT_STATUS.md for current phase state and known issues._

---

## Overview

Web_Recon_V3 is a full-pipeline website reconnaissance and replication system. Given any public URL, it crawls, analyses, blueprints, and deploys a functional replica. Work is organised into lettered phases; each phase has a clear entry criterion (the previous phase complete) and a clear exit criterion (smoke test or specific measurable outcome).

---

## Phase Structure

### Phase A — Foundations ✅
**Goal:** Establish monorepo, database, API scaffold, and shared tooling.

- pnpm workspace with TypeScript project references
- PostgreSQL + Drizzle ORM schema
- Express 5 API server with Pino logging
- OpenAPI spec + Orval codegen pipeline
- React + Vite dashboard scaffold
- Cloudflare R2 + local storage provider abstraction

**Exit criterion:** API healthcheck returns 200; DB migrations run clean.

---

### Phase B — Site Discovery & Crawling ✅
**Goal:** BFS crawler capable of discovering all pages of a target site.

- `lib/site-discovery` — BFS crawl frontier, link extraction, deduplication
- `artifacts/api-server/src/lib/crawl-frontier.ts` — frontier state management
- Scrape bridge to submit and track crawl jobs
- Manifest store — track page coverage, validate 96% gate

**Exit criterion:** Crawling https://example.com produces a complete manifest with 100% coverage.

---

### Phase C — Intelligence & Classification ✅
**Goal:** Detect target site's tech stack, design language, and brand identity.

- `lib/site-intelligence` — framework/backend detection (Next.js, React, static, etc.)
- `lib/design-dna` — archetype and brand classification
- `artifacts/api-server/src/lib/backend-detection-engine-d1.ts`
- Visual DNA extraction — colour palette, layout grid, typography
- Screenshot capture and pixel-comparison engine

**Exit criterion:** Intelligence stage correctly classifies example.com (static/unknown); design-dna returns archetype and brand tokens.

---

### Phase D — Stencil & Website Prime Generation ✅
**Goal:** Select a structural stencil and generate a site blueprint.

- `lib/stencil-library` — curated stencil templates
- `lib/stencil-registry` — stencil lookup and scoring
- `lib/stencil-assembly-engine` — assemble stencil from parts
- `lib/stencil-generator` — render stencil to HTML/CSS
- `lib/website-prime-generator` — generate full site blueprint (Website Prime)
- `lib/navigation-intelligence` — infer site navigation structure

**Exit criterion:** Website Prime stage produces a valid blueprint JSON for the target site.

---

### Phase E — Merge & Deployment Execution ✅
**Goal:** Merge the original site's content into the generated blueprint and deploy.

- `lib/merge-planner` — compute merge plan from diff + blueprint
- `lib/merge-execution-engine` — execute merge, produce final HTML
- `lib/deployment-planner` — multi-framework deployment plan (Replit, Vercel, static)
- `lib/deployment-adapters` — target-specific deploy adapters
- `lib/backend-profiler` — match backend requirements to target platform
- `lib/framework-profiler` — detect and adapt framework code
- R2 upload — ZIP artifact + index.html stored per job

**Exit criterion:** Deploy stage uploads to R2; public URL is accessible.

---

### Phase F — Job Dashboard & Control Center ✅
**Goal:** Full-featured React dashboard for operating the pipeline.

- Dashboard page — active job overview, pipeline stage progress, start new job
- Jobs page — full job list with pause/resume/retry/cancel/clone controls
- Job Mission Control — per-job detail with logs, stage timeline, quality scores
- Recovery Center — autonomous repair, manual override, rollback
- Differential Center — diff-against-baseline workflow
- Manifest Center — manifest validation and coverage view
- Storage page — R2 object listing, metrics, upload status
- Diagnostics + Audit pages — system health, route audit, event stream log
- SSE event stream — real-time pipeline progress via `GET /api/events`

**Exit criterion:** All pages render without errors; SSE delivers live events; job controls work end-to-end.

---

### Phase G — Full End-to-End Pipeline Smoke Test ✅
**Goal:** Validate the complete 12-stage pipeline on a real URL.

Pipeline stages:
1. `crawl` — BFS discovery + full-site scraping
2. `manifest` — verify content manifest & 96% coverage gate
3. `diff` — detect changes vs baseline (skip if no baseline)
4. `intelligence` — deployment environment analysis
5. `design-dna` — archetype & brand classification
6. `visual-dna` — layout & colour extraction
7. `stencil` — select & assemble stencil
8. `website-prime` — generate site blueprint
9. `merge` — compile merge plan
10. `deployment-plan` — multi-framework deployment plan
11. `deploy` — execute & verify deployment (upload to R2)
12. `certification` — production readiness gate (quality score, fidelity, coverage)

**Result:** https://example.com — all 12 stages complete; R2 upload confirmed; certification grade F/56 (expected for stub site). ~70 second total duration.

**Exit criterion:** Full pipeline completes without fatal errors on a live URL.

---

### Phase H — Polish & Hardening 🔄 (Current)
**Goal:** Production-quality reliability, improved fidelity scores, and deployment readiness.

Planned work:
- [ ] Fix orphaned R2 artifact for job `cb2e6c78` (manual ZIP regeneration)
- [ ] Improve visual fidelity scores from 75–82 to ≥ 90
- [ ] Add retry-with-backoff for transient R2 upload failures
- [ ] Improve recovery engine auto-repair rate (currently 0%)
- [ ] Dashboard UX: empty states, error handling, loading skeletons, toast notifications
- [ ] Enforce deployment checklist pre-flight (DB migrations, env vars)
- [ ] Hardened certification engine with real-site scoring profiles
- [ ] Load test and performance profiling (E1 route suite)
- [ ] Security hardening review (E2 route suite)

**Exit criterion:** Real-world site (not example.com) completes pipeline with fidelity ≥ 85 and certification grade ≥ C.

---

### Phase I — Production Deployment (Planned)
**Goal:** Deploy Web_Recon_V3 itself to production as a hosted service.

- Provision production PostgreSQL
- Set all required secrets (R2 creds, DATABASE_URL, SESSION_SECRET)
- Run DB migrations against production
- Deploy via Replit Deployments
- Smoke test against production endpoint
- Monitor via existing pipeline health infrastructure

**Exit criterion:** Production URL returns API healthcheck 200; dashboard loads; pipeline completes a job end-to-end.

---

## Conventions

- **Do not change `info.title` in `lib/api-spec/openapi.yaml`** — it controls generated filenames in `lib/api-client-react` and `lib/api-zod`. Breaking this breaks all hook imports.
- **Never call `pnpm dev` at workspace root** — run individual artifacts via their managed Replit workflows.
- **All backend logging via `req.log` or the singleton `logger`** — never `console.log` in server code.
- **DB changes require `pnpm --filter @workspace/db run push`** — run against dev before touching prod.
- **R2_ACCOUNT_ID and R2_PUBLIC_BASE_URL are non-secret env vars; the three R2 credential keys are Replit Secrets.**
