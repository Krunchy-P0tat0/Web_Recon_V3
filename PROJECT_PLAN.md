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

### Phase D4 — Knowledge Engine & Intelligent Execution

Phase D4 extends the pipeline with persistent knowledge, intelligent execution decisions, and differential planning. D4.1 (Website Memory) and D4.2 (Checkpoint Engine) are complete. D4.3 adds the Intelligent Differential Execution Planner.

---

### D4.3 — Intelligent Differential Execution Planner 🚧 (Current)

**Goal:** Before every pipeline run, inspect Website Memory to determine the minimum required work — eliminating redundant crawling, regeneration, and processing.

**Objective:**
The planner must inspect Website Memory before every crawl and determine minimum required work by distinguishing:
1. Missing knowledge — modules that have never been generated
2. Outdated knowledge — modules whose generatorVersion has been upgraded
3. Current valid knowledge — modules that are healthy and up-to-date
4. Website changes — URLs added/removed/changed detected via manifest comparison
5. Interrupted work — pipeline state that can be resumed from last checkpoint

**Architecture Changes:**

1. **New file: `artifacts/api-server/src/lib/differential-execution-planner.ts`**
   - `IntelligentDifferentialExecutionPlanner` class
   - `createExecutionPlan()` — inspects memory, evaluates modules, generates plan
   - `evaluateKnowledgeModule()` — checks module health vs required versions
   - `evaluateDependencyGraph()` — traverses module dependencies downward
   - `detectWebsiteChanges()` — compares manifests for URL/content changes
   - `selectExecutionMode()` — chooses fresh/differential/resume/upgrade/regenerate
   - `estimateWork()` — estimates remaining work based on modules to run

2. **New file: `artifacts/api-server/src/lib/differential-execution-planner-types.ts`**
   - `KnowledgeModuleStatus` — "missing" | "outdated" | "current"
   - `ExecutionMode` — "fresh" | "differential" | "resume" | "upgrade" | "regenerate-website-prime"
   - `WebsiteChangeSummary` — URLs added/removed/changed/unchanged, assets added/changed/unchanged
   - `ExecutionPlan` — full plan output with all required fields
   - `ModuleDependencyGraph` — explicit module dependency definitions

3. **New route: `artifacts/api-server/src/routes/execution-planner.ts`**
   - `POST /execution-planner/plan` — generate an execution plan for a website
   - `GET /execution-planner/plan/:websiteId` — retrieve latest plan

4. **Modified: `artifacts/api-server/src/routes/orchestrate.ts`**
   - Accept optional `executionMode` parameter
   - Optionally run planner before pipeline to determine stages

5. **Modified: `artifacts/api-server/src/lib/master-orchestrator.ts`**
   - Integrate execution planner as a pre-pipeline step
   - Support skipping stages based on planner output
   - Support resume-from-checkpoint via `executionMode: "resume"`

6. **Modified: `artifacts/api-server/src/routes/index.ts`**
   - Register new execution-planner route

**Knowledge Module Versioning:**
Each knowledge module tracks: moduleName, moduleVersion, generatorVersion, dependencies, outputChecksum, generatedAt, health. When Web Recon upgrades an engine, the planner compares required module versions against stored versions to determine MISSING / OUTDATED / CURRENT states.

**Dependency Graph:**
```
Manifest
↓
Visual DNA
↓
Brand DNA
↓
Website Prime
↓
Production Certification
```

If a module is outdated, regenerate it AND evaluate all dependent modules. Do NOT rerun unrelated modules.

**Execution Modes:**
1. **Fresh Crawl** — ignore previous knowledge, perform complete analysis
2. **Differential Crawl** — compare existing memory, execute only required work
3. **Resume Interrupted Crawl** — restore persisted state, continue from last checkpoint
4. **Upgrade Knowledge** — upgrade outdated knowledge modules
5. **Regenerate Website Prime** — generate final outputs without unnecessary crawling

**Execution Plan Output:**
The planner exposes: website, memoryStatus, knowledgeStatus, websiteChangeSummary, missingModules, outdatedModules, affectedDownstreamModules, recommendedStages, estimatedWork, reusableArtifacts, unavailableArtifacts, recoveryOptions

**Files Affected:**
- `artifacts/api-server/src/lib/differential-execution-planner.ts` (NEW)
- `artifacts/api-server/src/lib/differential-execution-planner-types.ts` (NEW)
- `artifacts/api-server/src/routes/execution-planner.ts` (NEW)
- `artifacts/api-server/src/routes/orchestrate.ts` (MODIFY)
- `artifacts/api-server/src/lib/master-orchestrator.ts` (MODIFY)
- `artifacts/api-server/src/routes/index.ts` (MODIFY)

**Dependencies:**
- D4.1 Website Memory types and service (`website-memory-types.ts`, `website-memory-service.ts`)
- D4.2 Checkpoint Engine (`checkpoint-engine.ts`)
- Diff Engine (`diff-engine.ts`)
- Master Orchestrator (`master-orchestrator.ts`)
- Crawl state machine (`pipeline-state-machine.ts`)
- Existing generator engines (visual-dna-engine, brand-dna-engine, certification-engine-c6)

**Exit criterion:** Planner generates correct execution plans for Scenarios A–E (see PROJECT_STATUS.md) and routes return valid JSON responses.

---

### Codebase Discovery Findings (D4.3 Stage 0.2)

**Existing Capabilities That Will Be Reused:**

| Capability | Source File | How It Maps to D4.3 |
|---|---|---|
| Website Memory manifest | `website-memory-types.ts`, `website-memory-service.ts` | Planner reads knowledgeModules to determine module health, version, checksum |
| KnowledgeModule version tracking | `website-memory-types.ts:57-82` | Module.version (numeric) + moduleVersions map; generatorVersion semver string |
| Module health states | `website-memory-types.ts:48-55` | healthy/stale/error/missing — planner derives MISSING/OUTDATED/CURRENT from these |
| Module dependency tracking | `website-memory-types.ts:70` | dependencies: PipelineStageKey[] — planner traverses these for cascade regeneration |
| Content hash computation | `diff-engine.ts:92-98` | SHA-256 of normalized cleanHtml — used for website change detection |
| Diff classification | `diff-engine.ts:229-366` | NEW/CHANGED/UNCHANGED/DELETED URL classification — feeds websiteChangeSummary |
| Checkpoint save/load/resume | `checkpoint-engine.ts:191-334` | saveCheckpoint/loadCheckpoint/computeResumeList — resume interrupted crawl mode |
| Crawl job submission | `scrape-bridge.ts:29-50` | submitScrapeJob with diffMode/baseJobId — used by execution modes |
| Manifest load/save | `manifest-store.ts:84-128` | loadManifest(jobId) — loads manifests for website change detection |
| URL normalization | `crawl-frontier.ts:87` | normalizeUrlFrontier — ensures consistent URL comparison |
| Pipeline state machine | `pipeline-state-machine.ts:27-43` | 15 states, pause/resume/cancel/retry — state management for execution modes |
| Orchestration job creation | `master-orchestrator.ts:387-415` | createJob(opts) — creates jobs with url, baseJobId, coverageThreshold |
| Route registration pattern | `routes/index.ts:89-166` | router.use(importedRouter) — standard pattern for adding new routes |

**Generator Version Constants (existing/found):**

| Engine | Version | Defined In |
|---|---|---|
| Brand DNA | `"BrandDNA-v1"` | `brand-dna-engine.ts:209` |
| Visual DNA | *(no explicit version)* | `visual-dna-engine.ts` — needs version constant added |
| Certification | *(no explicit version)* | `certification-engine-c6.ts` — needs version constant added |
| Crawler | `"3.0.0"` | `website-memory-types.ts:20` |
| Diff Engine | *(no explicit version)* | `diff-engine.ts` — uses content hash comparison |
| Manifest | schema version `"1.0"` | `manifest.ts:176` |

**Missing Components Required for D4.3:**

1. **No execution planner class** — Need `differential-execution-planner.ts` with IntelligentDifferentialExecutionPlanner
2. **No knowledge module version comparator** — Logic to compare stored generatorVersion against required generatorVersion
3. **No dependency graph definition** — Need explicit module-to-module dependency map (e.g., Manifest → Visual DNA → Brand DNA → Website Prime → Certification)
4. **No execution plan type** — Need `ExecutionPlan` interface with all required output fields
5. **No execution modes** — Need fresh/differential/resume/upgrade/regenerate-website-prime dispatch logic
6. **No website change detection service** — Need service wrapping existing diff-engine.ts for plan consumption
7. **No API endpoint** — Need `POST /execution-planner/plan` route
8. **No orchestrator integration** — Need planner call before pipeline stages in master-orchestrator.ts
9. **Missing generator versions** — visual-dna-engine and certification-engine-c6 need explicit version constants
10. **No resume-from-checkpoint path** — master-orchestrator.ts doesn't load/use checkpoint-engine

**Implementation Approach:**
1. Create `lib/differential-execution-planner-types.ts` — all new types/interfaces
2. Create `lib/differential-execution-planner.ts` — planner class + website change detection
3. Add generator version constants to visual-dna-engine.ts and certification-engine-c6.ts
4. Create `routes/execution-planner.ts` — POST /execution-planner/plan endpoint
5. Modify `routes/orchestrate.ts` — accept executionMode parameter
6. Modify `master-orchestrator.ts` — run planner pre-pipeline for mode selection
7. Register new route in `routes/index.ts`

---

### D4.4 — Persistent Memory & Differential UX 🔄 (Current)

**Goal:** Expose the D4.3 Intelligent Differential Execution Planner and D4.1 Website Memory through Mission Control. When a URL is entered, the dashboard queries existing knowledge, shows memory status, and lets the operator choose an informed execution mode before launching.

**Objective:**
Mission Control should surface the capabilities already built in D4.1–D4.3 without recreating any backend logic. All intelligence lives in existing services; this phase is a UX layer on top.

**Planned UI Additions:**
- New page: **Website Memory Center** (`/memory`) — URL-input-driven memory inspection and action launcher
- URL search box → calls `POST /api/execution-planner/plan` → displays full plan
- **Memory Status card**: Website Found / Not Found, Last Crawl, Last Successful Pipeline, Knowledge Version, Pipeline State, WebsitePrime Status
- **Knowledge Modules grid**: 12 pipeline stages, each with status badge (✓ Current / ⚠ Outdated / ✗ Missing), generatedAt, generatorVersion
- **Website Change Summary**: detected/not, URLs added/removed/changed/unchanged
- **Recovery Panel**: canResume, lastCheckpointStage, checkpointJobId
- **Available Actions** (mode buttons that call `POST /api/orchestrate` with correct `executionMode`):
  - START FRESH CRAWL
  - RUN DIFFERENTIAL CRAWL
  - RESUME INTERRUPTED CRAWL
  - UPGRADE KNOWLEDGE
  - GENERATE WEBSITE PRIME
  - REBUILD FAILED STAGE
- **Execution Plan Preview**: recommended stages list with skip/run indicators
- Sidebar nav entry added under Pipeline section

**Backend Endpoints Required:**
- `GET /api/website-memory?url=<url>` — lightweight memory summary (WebsiteMemorySummary) without full planner cost; returns `{ exists: false }` if no memory found (NEW route file)
- `POST /api/execution-planner/plan` — already exists (D4.3); drives the main plan view
- `POST /api/orchestrate` — already exists; accepts `executionMode` (D4.3 integration)

**Files Expected to Change:**
| File | Action |
|------|--------|
| `artifacts/api-server/src/routes/website-memory.ts` | NEW — GET /api/website-memory |
| `artifacts/api-server/src/routes/index.ts` | MODIFY — register website-memory route |
| `artifacts/dashboard/src/lib/planner-api.ts` | NEW — API client for planner + memory endpoints |
| `artifacts/dashboard/src/pages/WebsiteMemoryCenter.tsx` | NEW — full UX page |
| `artifacts/dashboard/src/components/layout/Sidebar.tsx` | MODIFY — add Memory nav entry |
| `artifacts/dashboard/src/App.tsx` | MODIFY — register /memory route |

**Reuse Strategy:**
- Reuse `WebsiteMemoryService` (D4.1) — no changes
- Reuse `IntelligentDifferentialExecutionPlanner` (D4.3) — no changes
- Reuse `POST /api/orchestrate` with `executionMode` (D4.3) — no changes
- Reuse `POST /api/jobs/:jobId/run-diff`, `generate-website-prime`, recovery endpoints
- Reuse existing dashboard patterns: Stat tiles, badge styles, SSE callbacks, query invalidation

**Dependencies:**
- D4.1 WebsiteMemoryService (`website-memory-service.ts`, `website-memory-types.ts`)
- D4.3 IntelligentDifferentialExecutionPlanner (`differential-execution-planner.ts`, `differential-execution-planner-types.ts`)
- Existing orchestrate route (`orchestrate.ts`)
- Existing jobs API (`jobs-api.ts`)
- Existing SSE infrastructure (`EventStreamContext.tsx`, `useEventStream.ts`)

**Exit Criterion:** Website Memory Center renders plan for any URL; all 6 action buttons successfully trigger the correct pipeline mode; plan preview shows correct stage list.

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

<!-- D4.4 implementation complete 2026-08-05 -->

---

## Phase R0 — Laboratory Recovery, Integration & Validation

**Objective:** Perform a complete recovery and integration audit of the Web Recon V3 repository. Discover every change made in the `laboratory` branch, compare against `main`, integrate into a new `lab-merge` staging branch, and produce a complete recovery report.

**Branch Strategy:**
- Source: `origin/laboratory`
- Target: `lab-merge` (created from `origin/main`)
- Main: never modified during this phase

**Expected Deliverables:**
- `docs/recovery/R0/BRANCH_DISCOVERY.md`
- `docs/recovery/R0/COMMIT_ARCHAEOLOGY.md`
- `docs/recovery/R0/BRANCH_DIFFERENCE_REPORT.md`
- `docs/recovery/R0/FEATURE_RECOVERY_MAP.md`
- `docs/recovery/R0/MERGE_READINESS_REPORT.md`
- `docs/recovery/R0/LAB_MERGE_SUMMARY.md`
- `docs/recovery/R0/VALIDATION_REPORT.md`
- `docs/recovery/R0/RECOVERY_MANIFEST.md`
- `docs/recovery/R0/RECONSTRUCTION_PLAN.md`

**Pipeline:**

| Stage | Description |
|-------|-------------|
| 0.1 | Task Analysis |
| 0.2 | Branch Discovery |
| 0.3 | Branch Archaeology |
| 0.4 | Laboratory Integration |
| 0.5 | Validation |
| 0.6 | Final Documentation |

<!-- Phase R0 complete 2026-08-05 — laboratory integrated into lab-merge -->
