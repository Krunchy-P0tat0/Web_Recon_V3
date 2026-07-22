# Web_Recon_V3 — Architecture Index

_This is the authoritative map of the codebase. Before inspecting code, locate the relevant module here first. Only read files directly referenced by the phase being implemented._

---

## Top-Level Layout

```
Web_Recon_V3/
├── artifacts/
│   ├── api-server/          # Express 5 backend — all pipeline logic lives here
│   └── dashboard/           # React + Vite frontend — operator console
├── lib/                     # Shared TypeScript libraries (20+)
├── scripts/                 # Utility scripts
├── lib/api-spec/            # OpenAPI source of truth → codegen
├── lib/api-client-react/    # Generated React Query hooks (DO NOT EDIT)
├── lib/api-zod/             # Generated Zod schemas (DO NOT EDIT)
└── lib/db/                  # Drizzle ORM schema + DB client
```

---

## API Server (`artifacts/api-server`)

Entry: `src/index.ts` → `src/app.ts`

The API server mounts all routes at both `/api` (internal self-calls) and `/recon-api` (reverse-proxy path).

### Route Index (`src/routes/index.ts`)
All route modules are flat-mounted on the Express router. ~70+ route files covering:

| Route file | Endpoints | Purpose |
|-----------|-----------|---------|
| `health.ts` | `GET /healthz` | Service health check |
| `orchestrate.ts` | `POST /orchestrate`, `GET /orchestrate`, `GET /orchestrate/:jobId` | **Primary pipeline entry point** — create and run jobs |
| `jobs.ts` | `GET /jobs`, `GET /jobs/:jobId`, `GET /jobs/:jobId/logs`, `GET /jobs/:jobId/manifest`, `POST /jobs/:jobId/{pause,resume,retry,cancel,clone,run-diff,generate-website-prime}` | Job control center |
| `events.ts` | `GET /events` | SSE stream — real-time pipeline progress |
| `progress.ts` | `GET /scrape-progress/:scrapeJobId` | Per-scrape-job progress |
| `recovery.ts` | Recovery endpoints | Manual recovery triggers |
| `differential.ts` | Differential crawl | Diff-against-baseline workflow |
| `storage.ts` | `GET /storage/status`, `GET /storage/metrics`, `GET /storage/objects` | R2 storage inspection |
| `deployment.ts` | Deployment management | Job deployment triggers |
| `platform.ts` | Platform feature registry | Target platform capabilities |
| `master-orchestration.ts` | Master orchestration control | Pipeline supervision |

_BM-series routes (bm1–bm12):_ API compatibility benchmarks — compatibility engine, route collision detection, DB compatibility, auth preservation, API compatibility, component merge, data binding, merge simulation, rollback generator, merge execution, merge intelligence, merge orchestrator.

_C-series routes (c1–c6):_ Quality/certification subsystems — incremental regeneration, asset intelligence, runtime performance, SEO intelligence, runtime optimizer, certification.

_D-series routes (d1–d5):_ Deployment intelligence — backend detection, semantic merge, merge execution, API contract validation, merge certification.

_E-series routes (e1–e5):_ Hardening — load test, security hardening, observability, disaster recovery, production certification.

_VR-series routes (vr5–vr8):_ Visual refinement — visual stencil mapper, consistency engine, visual fidelity, reconstruction loop.

_PH-series routes (ph2, ph3, ph5):_ Pipeline health — monitoring, regression validation, monitoring persistence.

### Core Library Engines (`src/lib/`)

| File | Purpose |
|------|---------|
| `master-orchestrator.ts` | Orchestrates all 12 pipeline stages sequentially; source of truth for stage order |
| `scrape-bridge.ts` | Submits crawl jobs; bridges to site-discovery lib |
| `manifest-store.ts` | Loads/saves page manifests; validates 96% coverage gate |
| `manifest-export.ts` | Renders manifest to downloadable JSON |
| `job-dashboard.ts` | Aggregates job state for the dashboard (all job sets, summary) |
| `db-queue.ts` | DB-backed job queue — persists job records in PostgreSQL |
| `event-bus.ts` | In-process SSE event bus — emits pipeline events to the `/events` stream |
| `generation-runner.ts` | Runs the Website Prime generation pipeline |
| `construction-runner.ts` | Runs the site construction phase |
| `deployment-executor.ts` | Executes deployment to the target platform |
| `deployment-intelligence.ts` | Analyses target environment and constraints |
| `diff-engine.ts` | Computes content diff vs baseline job |
| `brand-dna-engine.ts` | Brand and archetype classification |
| `canonical-color-engine.ts` | Canonical colour palette extraction |
| `certification-engine-c6.ts` | Production readiness gate — scores quality, fidelity, coverage |
| `cloud-storage.ts` | Storage abstraction — wraps R2 / local provider |
| `cloud-renderer.ts` | Renders site to static files for cloud upload |
| `decision-engine.ts` | Multi-criteria decision engine for stencil selection |
| `failure-classifier.ts` | Classifies pipeline failures for recovery routing |
| `autonomous-recovery-engine.ts` | Auto-repairs diagnosed issues |
| `checkpoint-engine.ts` | Saves/restores pipeline checkpoints |
| `crawl-frontier.ts` | BFS crawl frontier state |
| `embed-extractor.ts` | Extracts embedded assets (scripts, styles, images) |

### Cloud Storage (`src/cloud/`)

| File | Purpose |
|------|---------|
| `provider.ts` | `CloudProvider` interface — `upload`, `download`, `list`, `delete` |
| `r2.provider.ts` | Cloudflare R2 implementation (primary) |
| `local.provider.ts` | Local filesystem fallback (dev/offline) |
| `index.ts` | `getDefaultCloudProvider()` — returns R2 if env vars present, local otherwise |

R2 env vars: `R2_ACCOUNT_ID`, `R2_PUBLIC_BASE_URL` (non-secret). R2 secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.

### Database (`src/db/`)

Schema source of truth: **`lib/db/src/schema/index.ts`**

Key tables (via Drizzle ORM):
- `generationReportsTable` — Website Prime generation results per job
- `constructionReportsTable` — Site construction results per job
- Job queue tables managed by `db-queue.ts`

---

## Dashboard (`artifacts/dashboard`)

Entry: `src/main.tsx` → `src/App.tsx`

Router: Wouter with `base={import.meta.env.BASE_URL}` (path-aware for Replit proxy).

### Pages (`src/pages/`)

| Page | Route | Purpose |
|------|-------|---------|
| `Dashboard.tsx` | `/` | Active job overview; start new pipeline job; stage progress cards |
| `Jobs.tsx` | `/jobs` | Full job list with controls (pause/resume/retry/cancel/clone/diff/prime) |
| `JobMissionControl.tsx` | `/jobs/:jobId` | Per-job deep detail — logs, stage timeline, quality scores, certify |
| `RecoveryCenter.tsx` | `/recovery` | Autonomous repair, manual override, rollback triggers |
| `DifferentialCenter.tsx` | `/differential` | Diff-against-baseline workflow |
| `ManifestCenter.tsx` | `/manifest` | Manifest validation, coverage view, download |
| `Storage.tsx` | `/storage` | R2 object listing, storage metrics, upload status |
| `Diagnostics.tsx` | `/dev/diagnostics` | System health, API route status |
| `Audit.tsx` | `/dev/audit` | Event stream log, orchestration audit |
| `not-found.tsx` | `*` | 404 fallback |

### Hooks (`src/hooks/`)

| Hook | Purpose |
|------|---------|
| `useEventStream.ts` | Subscribes to `GET /api/events` SSE; provides `useEventStreamCallback` and `useEventStreamStatus` |

### Contexts (`src/contexts/`)

| Context | Purpose |
|---------|---------|
| `EventStreamProvider` | Single shared SSE connection for the entire app |

### API Client

Generated hooks live in `lib/api-client-react/src/generated/api.ts`.  
Import from `@workspace/api-client-react` — **never from relative paths**.

Key hooks:
- `useListPipelineJobs` / `getListPipelineJobsQueryKey`
- `useGetPipelineJob` / `getGetPipelineJobQueryKey`
- `useStartPipelineJob`
- `useGetScrapeProgress`
- `useGetStorageStatus`, `useGetStorageMetrics`, `useListStorageObjects`

---

## Shared Libraries (`lib/`)

### Source of Truth Libraries

| Library | Purpose |
|---------|---------|
| `lib/api-spec` | `openapi.yaml` — **DO NOT change `info.title`** (controls generated filenames). Run `pnpm --filter @workspace/api-spec run codegen` after changes. |
| `lib/api-client-react` | Generated React Query hooks — DO NOT edit generated files |
| `lib/api-zod` | Generated Zod schemas — DO NOT edit generated files |
| `lib/db` | Drizzle schema + DB client (`src/schema/index.ts` is the schema source of truth) |

### Pipeline Libraries

| Library | Purpose |
|---------|---------|
| `lib/site-discovery` | BFS crawler, link extractor, page discovery |
| `lib/site-intelligence` | Framework/backend detection (Next.js, React, static, etc.) |
| `lib/design-dna` | Archetype and brand classification |
| `lib/generation-pipeline` | Website Prime generation pipeline |
| `lib/website-prime-generator` | Generates site blueprint from design DNA + manifest |
| `lib/stencil-library` | Curated structural stencil templates |
| `lib/stencil-registry` | Stencil lookup, scoring, and selection |
| `lib/stencil-assembly-engine` | Assembles stencil from component parts |
| `lib/stencil-generator` | Renders assembled stencil to HTML/CSS |
| `lib/merge-planner` | Computes merge plan from diff + blueprint |
| `lib/merge-execution-engine` | Executes merge; produces final HTML |
| `lib/deployment-planner` | Multi-framework deployment planning |
| `lib/deployment-adapters` | Target-specific deploy adapters (Replit, Vercel, static) |
| `lib/navigation-intelligence` | Infers site navigation structure |
| `lib/content-placement` | Places content into stencil slots |
| `lib/manifest-binding` | Binds manifest data to generated templates |
| `lib/theme-intelligence` | Theme token extraction and application |
| `lib/framework-profiler` | Detects and adapts framework-specific code patterns |
| `lib/backend-profiler` | Matches backend requirements to target platform |
| `lib/site-constructor` | Assembles the final site from all pipeline outputs |
| `lib/version-intelligence` | Detects library/framework versions in target site |

---

## The 12-Stage Pipeline

Defined in: `artifacts/api-server/src/lib/master-orchestrator.ts`

```
1.  crawl            lib/site-discovery          BFS discovery + full-site scraping
2.  manifest         src/lib/manifest-store.ts   Verify content manifest & 96% coverage gate
3.  diff             src/lib/diff-engine.ts      Detect changes vs baseline (skip if no baseline)
4.  intelligence     lib/site-intelligence       Deployment environment analysis
5.  design-dna       lib/design-dna              Archetype & brand classification
6.  visual-dna       src/lib/canonical-color-engine.ts  Layout & colour extraction
7.  stencil          lib/stencil-registry        Select & assemble stencil
8.  website-prime    lib/website-prime-generator Generate site blueprint
9.  merge            lib/merge-planner           Compile merge plan
10. deployment-plan  lib/deployment-planner      Multi-framework deployment plan
11. deploy           src/lib/deployment-executor.ts  Execute & verify deployment (R2 upload)
12. certification    src/lib/certification-engine-c6.ts  Production readiness gate
```

---

## Data Flow

```
User submits URL (POST /api/orchestrate)
  → master-orchestrator creates job (DB)
  → stage 1: crawl  → scrape-bridge → site-discovery lib → manifest stored in DB
  → stage 2: manifest validation (96% gate)
  → stage 3: diff (skip if no baseJobId)
  → stage 4: intelligence → site-intelligence lib → environment report stored
  → stage 5: design-dna → design-dna lib → archetype + brand tokens
  → stage 6: visual-dna → screenshot capture → colour/layout extraction
  → stage 7: stencil → stencil-registry selects stencil → stencil-assembly-engine assembles
  → stage 8: website-prime → website-prime-generator → blueprint JSON stored (generationReportsTable)
  → stage 9: merge → merge-planner → merge plan JSON
  → stage 10: deployment-plan → deployment-planner → platform-specific plan
  → stage 11: deploy → deployment-executor → R2 upload (ZIP + index.html)
  → stage 12: certification → quality score + fidelity + coverage gate → grade A–F

Events emitted to SSE bus at each stage transition.
Dashboard receives real-time updates via EventStreamProvider.
```

---

## Key Conventions

1. **Never edit generated files** — `lib/api-client-react/src/generated/*` and `lib/api-zod/src/generated/*` are overwritten by codegen.
2. **No `console.log` in server code** — use `req.log` in route handlers, `logger` singleton elsewhere.
3. **Backend imports use `.js` extension** — TypeScript ESM requires explicit `.js` in relative imports.
4. **OpenAPI `info.title` is frozen** — changing it renames generated files and breaks all hook imports across the dashboard.
5. **R2 uploads are job-scoped** — all assets stored under `jobs/{jobId}/` prefix in R2.
6. **SSE events carry stage IDs** — event types match the 12 stage IDs above; the dashboard STAGES array is the canonical label map.
