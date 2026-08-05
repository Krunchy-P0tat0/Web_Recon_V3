# FEATURE_RECOVERY_MAP.md
## Phase R0 — Feature Recovery Map
**Generated:** 2026-08-05  
**Source Branch:** `origin/laboratory`

---

## Feature Inventory

### F01 — D4.3 Intelligent Differential Execution Planner

| Field | Value |
|-------|-------|
| Phase | D4.3 |
| Status | ✅ **Complete** |
| Completion % | 100% |
| Commits | C02, C03, C04 |
| Authors | Killianmbp, Replit Agent |

**Source Files:**

| File | Role | Status |
|------|------|--------|
| `artifacts/api-server/src/lib/differential-execution-planner-types.ts` | Type definitions | ✅ Ready |
| `artifacts/api-server/src/lib/differential-execution-planner.ts` | Core engine | ✅ Ready |
| `artifacts/api-server/src/routes/execution-planner.ts` | API endpoint `POST /api/execution-planner/plan` | ✅ Ready |
| `artifacts/api-server/src/routes/index.ts` | Route registration | ✅ Modified |
| `artifacts/api-server/src/routes/orchestrate.ts` | executionMode param | ✅ Modified |
| `artifacts/api-server/src/lib/master-orchestrator.ts` | Orchestrator integration | ✅ Modified |
| `artifacts/api-server/src/lib/certification-engine-c6.ts` | Engine hooks | ✅ Modified |
| `artifacts/api-server/src/lib/visual-dna-engine.ts` | Engine hooks | ✅ Modified |

**Dependencies:**
- D4.1 PWIM (already in main via `4a60bee`)
- D4.2 Checkpoint Engine (already in main)
- `@workspace/db` schema

**Known Issues:**
- Pre-existing TypeScript errors in `workflow-orchestrator.ts` and `jobs.ts` (missing `@workspace/db` exports) — not caused by D4.3, pre-date this work
- These do not block D4.3 runtime functionality (esbuild bundles successfully)

**Readiness:** ✅ **Ready to test**  
**Merge Conflicts Expected:** None

---

### F02 — D4.4 Persistent Memory & Differential UX

| Field | Value |
|-------|-------|
| Phase | D4.4 |
| Status | ✅ **Complete** |
| Completion % | 100% |
| Commits | C06, C07, C08, C09, C10 |
| Authors | Replit Agent |

**Source Files:**

| File | Role | Status |
|------|------|--------|
| `artifacts/api-server/src/routes/website-memory.ts` | `GET /api/website-memory?url=` | ✅ Ready |
| `artifacts/api-server/src/routes/index.ts` | Route registration | ✅ Modified |
| `artifacts/dashboard/src/lib/planner-api.ts` | TypeScript API client | ✅ Ready |
| `artifacts/dashboard/src/pages/WebsiteMemoryCenter.tsx` | Full UX page | ✅ Ready |
| `artifacts/dashboard/src/components/layout/Sidebar.tsx` | Nav entry | ✅ Modified |
| `artifacts/dashboard/src/App.tsx` | Route `/memory` | ✅ Modified |

**Dependencies:**
- F01 (D4.3 Execution Planner) — `WebsiteMemoryCenter` calls `POST /api/execution-planner/plan`
- D4.1 PWIM service — `WebsiteMemoryService.getWebsiteMemorySummary()`
- `wouter` (already installed in dashboard)
- Lucide React icons (already installed)

**UX Features Implemented:**
- URL input → full execution plan display
- Memory Status card
- Recovery Panel (checkpoint/interrupt detection)
- Website Change Summary
- 5 execution mode action buttons with recommended badge
- 12-stage execution plan preview
- Knowledge Modules grid
- SSE live refresh

**Known Issues:**
- None introduced by D4.4
- Pre-existing dashboard TypeScript errors in `Audit.tsx`, `Dashboard.tsx`, `JobMissionControl.tsx` not caused by D4.4

**Readiness:** ✅ **Ready to test**  
**Merge Conflicts Expected:** None

---

### F03 — Runtime Health Artifact Updates

| Field | Value |
|-------|-------|
| Phase | Maintenance |
| Status | ⚠️ **Auto-generated / Non-functional** |
| Completion % | N/A |
| Commits | C01, C11 |
| Authors | Replit Agent |

**Files:**
- `artifacts/api-server/job-health-report.json`
- `artifacts/api-server/job-supervisor-report.json`
- `artifacts/api-server/override-policy.json`
- `artifacts/api-server/pipeline-state-machine.json`
- `artifacts/api-server/worker-status-report.json`
- `deployment-audit.json`
- `health-report.json`
- `override-policy.json`
- `pipeline-health.json`
- `pipeline-repair.json`
- `recovery-report.json`
- `repair-plan.json`

**Notes:** These are runtime-generated JSON files updated by the API server at startup/runtime. They carry no functional logic and should not be used as source of truth. Their inclusion in git history is a minor anti-pattern but does not cause harm.

**Readiness:** ⚠️ Not applicable — runtime data  
**Merge Conflicts Expected:** Possible (same files may differ in main) — safe to take laboratory version

---

### F04 — Agent Memory Documentation

| Field | Value |
|-------|-------|
| Phase | Infra |
| Status | ✅ Complete |
| Completion % | 100% |
| Commits | C05 |
| Authors | Replit Agent |

**Files:**
- `.agents/memory/github-auth.md` (new)
- `.agents/memory/MEMORY.md` (modified — index entry)

**Content:** Documents GitHub PAT authentication quirks (Basic auth with `x-access-token` prefix required for Git transport). Useful operational knowledge.

**Readiness:** ✅ Safe to merge

---

### F05 — D3.5 True Differential Recovery (agent/laboratory only)

| Field | Value |
|-------|-------|
| Phase | D3.5 |
| Status | 🔬 **Experimental — Not in lab-merge scope** |
| Completion % | Unknown |
| Branch | `origin/agent/laboratory` only |
| Authors | lake11 |

**Notes:** This feature exists only on `origin/agent/laboratory`, which diverged from main 4 commits behind. Not included in this R0 integration. Recommended for a separate R0.5 sub-phase.

**Readiness:** 🔬 Requires separate recovery sub-phase

---

### F06 — Phase H Visual Fidelity Improvements (agent/laboratory only)

| Field | Value |
|-------|-------|
| Phase | H |
| Status | 🔬 **Experimental — Not in lab-merge scope** |
| Completion % | Unknown |
| Branch | `origin/agent/laboratory` only |
| Authors | Replit Agent |

**Notes:** Visual fidelity scoring improvements (target ≥ 85). Only on `origin/agent/laboratory`. Not included in this R0 integration.

**Readiness:** 🔬 Requires separate recovery sub-phase

---

## Feature Readiness Summary

| Feature | Phase | Ready | Partial | Experimental | Broken | Requires Testing | Likely Merge Conflicts |
|---------|-------|-------|---------|--------------|--------|-----------------|----------------------|
| F01 — D4.3 Execution Planner | D4.3 | ✅ | | | | ✅ | ❌ None |
| F02 — D4.4 Memory UX | D4.4 | ✅ | | | | ✅ | ❌ None |
| F03 — Runtime JSON Artifacts | Maint | | ✅ | | | | ⚠️ Possible (safe) |
| F04 — Agent Memory Docs | Infra | ✅ | | | | | ❌ None |
| F05 — D3.5 Diff Recovery | D3.5 | | | ✅ | | | N/A (out of scope) |
| F06 — Phase H Fidelity | H | | | ✅ | | | N/A (out of scope) |
