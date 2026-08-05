# BRANCH_DIFFERENCE_REPORT.md
## Phase R0 — Branch Difference Report
**Generated:** 2026-08-05  
**Comparing:** `origin/main` (`4a60bee`) vs `origin/laboratory` (`72cb294`)

---

## Summary

| Metric | Value |
|--------|-------|
| Commits unique to laboratory | 11 |
| Files added | 8 |
| Files modified | 21 |
| Files deleted | 0 |
| Files renamed | 0 |
| Net insertions | +2,491 |
| Net deletions | -124 |
| Merge base | `4a60bee` (= main tip) |
| Clean merge possible | ✅ Yes — laboratory is 0 commits behind main |

---

## New Files (Added Only in Laboratory)

| File | Lines | Feature |
|------|-------|---------|
| `artifacts/api-server/src/lib/differential-execution-planner-types.ts` | ~200 | D4.3 types |
| `artifacts/api-server/src/lib/differential-execution-planner.ts` | ~500 | D4.3 engine |
| `artifacts/api-server/src/routes/execution-planner.ts` | 87 | D4.3 API route |
| `artifacts/api-server/src/routes/website-memory.ts` | ~50 | D4.4 API route |
| `artifacts/dashboard/src/lib/planner-api.ts` | 171 | D4.4 API client |
| `artifacts/dashboard/src/pages/WebsiteMemoryCenter.tsx` | 590 | D4.4 UI page |
| `.agents/memory/github-auth.md` | 10 | Auth docs |
| `pipeline-repair.json` | 44 | Runtime JSON |

---

## Modified Files (Changed Relative to Main)

### Source Code Changes

| File | Description |
|------|-------------|
| `artifacts/api-server/src/routes/index.ts` | +2 route registrations: `executionPlannerRouter`, `websiteMemoryRouter` |
| `artifacts/api-server/src/routes/orchestrate.ts` | Added `executionMode` parameter handling in `POST /api/orchestrate` |
| `artifacts/api-server/src/lib/master-orchestrator.ts` | Integration with differential planner; stage skip/resume support |
| `artifacts/api-server/src/lib/certification-engine-c6.ts` | Differential execution mode hooks |
| `artifacts/api-server/src/lib/visual-dna-engine.ts` | Minor modifications for planner integration |
| `artifacts/dashboard/src/App.tsx` | Added `import WebsiteMemoryCenter` + route `/memory` |
| `artifacts/dashboard/src/components/layout/Sidebar.tsx` | Added "Website Memory" nav item (Brain icon) |

### Documentation Changes

| File | Description |
|------|-------------|
| `PROJECT_PLAN.md` | Added D4.3 (55+100 lines) and D4.4 (57+2 lines) phase plans |
| `PROJECT_STATUS.md` | Updated through D4.4 Stage 0.4; includes full D4.3 and D4.4 status tables |
| `.agents/memory/MEMORY.md` | One new index entry for github-auth.md |

### Runtime JSON Changes

| File | Description |
|------|-------------|
| `artifacts/api-server/job-health-report.json` | Auto-generated server health snapshot |
| `artifacts/api-server/job-supervisor-report.json` | Auto-generated supervisor status |
| `artifacts/api-server/override-policy.json` | Auto-generated override config |
| `artifacts/api-server/pipeline-state-machine.json` | Auto-generated pipeline state |
| `artifacts/api-server/worker-status-report.json` | Auto-generated worker status |
| `deployment-audit.json` | Auto-generated deployment audit |
| `health-report.json` | Auto-generated system health |
| `override-policy.json` | Auto-generated policy |
| `pipeline-health.json` | Auto-generated pipeline health |
| `recovery-report.json` | Auto-generated recovery report |
| `repair-plan.json` | Auto-generated repair plan |
| `pipeline-repair.json` | Auto-generated (new file in laboratory) |

---

## Deleted Files

None.

---

## Renamed Files

None.

---

## Configuration Differences

| Area | Main | Laboratory | Impact |
|------|------|-----------|--------|
| API routes registered | D4.1 routes | + execution-planner + website-memory | Low — additive |
| Dashboard routes | 9 pages | + `/memory` (WebsiteMemoryCenter) | Low — additive |
| Dashboard sidebar | 9 nav items | + "Website Memory" | Low — additive |

---

## Dependency Changes

No new npm dependencies introduced in laboratory. All features use:
- Existing packages: `wouter`, `lucide-react`, `@tanstack/react-query` (all already installed)
- Internal workspace packages: `@workspace/db` (no schema changes in laboratory)

---

## Environment Changes

None. No `.env`, `Dockerfile`, `artifact.toml`, or workflow changes.

---

## Risk Assessment

| Risk | Severity | Notes |
|------|----------|-------|
| Clean merge into lab-merge | ✅ None | Laboratory is 0 behind main |
| Runtime JSON conflicts | ⚠️ Low | Auto-generated files may conflict — safe to take laboratory version |
| DB schema changes | ✅ None | No migration files changed |
| New dependencies | ✅ None | All packages already installed |
| Breaking API changes | ✅ None | All changes are additive |
| Pre-existing TS errors | ⚠️ Inherited | Pre-exist in main and laboratory; not introduced by D4.3/D4.4 |
