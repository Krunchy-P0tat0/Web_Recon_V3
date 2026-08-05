# RECONSTRUCTION_PLAN.md
## Phase R0 — Reconstruction & Testing Plan
**Generated:** 2026-08-05  
**Branch:** `lab-merge`

---

## Purpose

This document defines the recommended reconstruction and testing sequence for all features recovered into `lab-merge`. It is the operational guide for the next phase (feature testing and stabilization) before promoting `lab-merge` into `main`.

---

## Environment Setup

### Prerequisites

```bash
# 1. Switch to lab-merge
git checkout lab-merge
git pull origin lab-merge

# 2. Install dependencies
pnpm install

# 3. Push database schema
pnpm --filter @workspace/db run push

# 4. Start services
# (Via Replit workflows — do NOT run pnpm dev at workspace root)
# - artifacts/api-server: API Server
# - artifacts/dashboard: web
```

### Required Secrets/Env Vars

| Variable | Type | Required For |
|----------|------|-------------|
| `DATABASE_URL` | Secret | API server DB connection |
| `R2_ACCESS_KEY_ID` | Secret | R2 storage (pipeline artifacts) |
| `R2_SECRET_ACCESS_KEY` | Secret | R2 storage |
| `R2_BUCKET_NAME` | Secret | R2 storage |
| `R2_ACCOUNT_ID` | Env var | R2 storage |
| `R2_PUBLIC_BASE_URL` | Env var | R2 storage |
| `SESSION_SECRET` | Secret | Session management |

---

## Reconstruction Order

### Phase RT1 — API Smoke Tests

**Estimated time:** 15 minutes  
**Tools:** curl, browser DevTools, Postman/Insomnia

```bash
# Health check
curl https://$REPLIT_DEV_DOMAIN/api-server/health

# D4.1: Website memory — no prior crawl expected
curl "https://$REPLIT_DEV_DOMAIN/api-server/api/website-memory?url=https://example.com"
# Expected: {"exists":false} or {"exists":true, ...summary}

# D4.3: Execution planner
curl -X POST "https://$REPLIT_DEV_DOMAIN/api-server/api/execution-planner/plan" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
# Expected: full ExecutionPlan JSON
```

---

### Phase RT2 — Dashboard Navigation Tests

**Estimated time:** 10 minutes  
**Tools:** Browser

1. Open dashboard at preview URL
2. Verify all 10 nav items are present: Overview, Job Control, Recovery & Checkpoints, Website Memory, Differential, Manifest, Storage, Diagnostics, Platform Audit (+ new Website Memory)
3. Click "Website Memory" — confirm `/memory` route loads `WebsiteMemoryCenter`
4. Verify no console errors on page load

---

### Phase RT3 — D4.4 WebsiteMemoryCenter Full Flow

**Estimated time:** 20 minutes

1. Enter `https://example.com` (or any target URL) in the URL input
2. Click "Analyse"
3. **If no prior memory:** Verify "No memory found" state is displayed with prompt to run Fresh Build
4. **If memory exists:** Verify:
   - Memory Status card renders with correct values
   - Knowledge Modules grid shows all expected stages
   - Website Change Summary shows URL/asset counts
   - Action buttons are appropriately enabled/disabled
   - "Recommended" badge appears on the planner-suggested action
5. Click an action button — verify `POST /api/orchestrate` fires with correct `executionMode`

---

### Phase RT4 — D4.3 Differential Pipeline Test

**Estimated time:** 30 minutes (pipeline run time)

1. Run a full Fresh Build against a test URL via the dashboard
2. After completion, modify something on the target site (or use a different URL for second run)
3. Trigger a Differential run via WebsiteMemoryCenter
4. Verify in API logs:
   - Stages with existing artifacts are marked SKIP
   - Changed stages are marked RUN
   - New stages are marked MISSING/REBUILD

---

### Phase RT5 — Recovery & Checkpoint Test

**Estimated time:** 15 minutes

1. Start a pipeline run, then interrupt it mid-run
2. Navigate to Website Memory Center for that URL
3. Verify Recovery Panel shows: last checkpoint stage, interrupt indicator
4. Click "Resume" — verify pipeline resumes from checkpoint

---

## Known Pre-existing Issues (Must Not Block Testing)

| Issue | Workaround |
|-------|-----------|
| `scrape_jobs` relation not found on startup | Run `pnpm --filter @workspace/db run push` |
| TypeScript compile errors in `jobs.ts`, `progress.ts` | Pre-existing, no action needed — esbuild bundles fine |
| `@workspace/api-client-react` missing hooks | Pre-existing — Dashboard.tsx and JobMissionControl.tsx use fallback patterns |

---

## Out of Scope for This Phase

| Feature | Location | Action |
|---------|----------|--------|
| D3.5 True Differential Recovery | `origin/agent/laboratory` | Requires separate R0.5 recovery sub-phase |
| Phase H Visual Fidelity ≥ 85 | `origin/agent/laboratory` | Requires separate R0.5 recovery sub-phase |
| DB schema synchronization | `@workspace/db` | Separate technical debt ticket |
| API client regeneration | `@workspace/api-client-react` | Separate technical debt ticket |

---

## Promotion Gates (lab-merge → main)

All of the following must be checked off before promoting:

- [ ] RT1: All API smoke tests pass with HTTP 200
- [ ] RT2: All dashboard nav items load without errors
- [ ] RT3: WebsiteMemoryCenter full flow tested with real URL
- [ ] RT4: Differential pipeline executes correctly (at least one skip + one run)
- [ ] RT5: Resume-from-checkpoint works correctly
- [ ] No P0/P1 bugs discovered during RT1–RT5
- [ ] API server runs for 30+ minutes without fatal errors
- [ ] Decision made on agent/laboratory features (include or defer)

---

## Next Phase Recommendation

**Phase R1 — Feature Testing & Stabilization**

After completing RT1–RT5:
1. Fix any bugs found during testing
2. Fix DB schema synchronization (`@workspace/db` export gaps)
3. Fix API client regeneration (`@workspace/api-client-react` gaps)
4. Evaluate `origin/agent/laboratory` features for inclusion
5. Run final validation
6. Merge `lab-merge` into `main`
