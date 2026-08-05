# BRANCH_DISCOVERY.md
## Phase R0 — Branch Discovery Report
**Generated:** 2026-08-05  
**Analyst:** Replit Agent (Phase R0)

---

## Repository

| Field | Value |
|-------|-------|
| Remote | `https://github.com/Krunchy-P0tat0/Web_Recon_V3.git` |
| Default Branch | `main` |
| Snapshot Date | 2026-08-05 |

---

## All Branches

### Remote Branches

| Branch | Latest Hash | Ahead Main | Behind Main | Last Commit Date | Last Commit Message |
|--------|-------------|-----------|-------------|-----------------|---------------------|
| `origin/main` | `4a60bee` | — | — | 2026-08-01 | [Phase D4.1] Persistent Website Memory Foundation |
| `origin/laboratory` | `72cb294` | **11** | **0** | 2026-08-05 | Update API server artifact reports and add pipeline repair configuration |
| `origin/agent/laboratory` | `3eff18a` | 13 | 4 | 2026-07-31 | [Phase D4.1] Persistent Website Memory Foundation (PWIM) |

### Local Branches

| Branch | HEAD | Tracking | Notes |
|--------|------|----------|-------|
| `laboratory` | `72cb294` | `origin/laboratory` | In sync with remote after session push |
| `main` | `4a60bee` | `origin/main` | In sync |
| `replit-agent` | (local) | — | Internal Replit metadata branch |
| `lab-merge` | `4a60bee` | `origin/main` | **Created this session** — staging target for R0 |

---

## Laboratory Branch — Identified

**Primary laboratory branch: `origin/laboratory`**

Selection criteria:
- Most recent commit: **2026-08-05** (newest of all experimental branches)
- **0 commits behind main** — cleanly diverged, no merge divergence
- Contains all D4.3 and D4.4 phase work
- Contains all D4.4 commits from this Replit session

**Secondary branch of interest: `origin/agent/laboratory`**  
- 13 commits ahead of main, 4 behind — diverged at an earlier commit
- Contains unique features: D3.5 (Differential Recovery), Phase H fidelity improvements
- These commits are NOT present in `origin/laboratory` and will be documented in the archaeology report

---

## Branch Topology

```
9692a6b  Initial commit
   |
1529bb6  Phase G — full 19-stage pipeline, R2 deploy, dashboard
   |
356b262  docs: PROJECT_STATUS, PROJECT_PLAN, ARCHITECTURE_INDEX
   |
7829cbe  docs: sync-docs, post-commit hook, replit.md
   |
4b1d528  Phase H: IS-001 regenerate, R2 retry hardening, cert engine
   |
81e3ae5  Phase D3.4: R2 Persistent Knowledge Storage
   |
b5757dc  fix: jobStorageRouter registration order
   |
c05d58c  Update artifacts and add setup memory docs
   |
a1f9c97  feat(D3.5): True Differential Recovery    ← agent/laboratory only
   |
821ff53  Merge remote-tracking branch 'github/main' ← agent/laboratory only
   |
213d19d  Phase H: Visual fidelity ≥ 85             ← agent/laboratory only
   |
3eff18a  [Phase D4.1] PWIM (agent/lab)             ← agent/laboratory tip
   |
   | ← main diverges here →
4a60bee  [Phase D4.1] Persistent Website Memory (main tip)
   |
2d42c8a  Update status and health report artifacts  ← laboratory starts here
   |
81cfaa2  [Phase D4.3][0.1] Task analysis
   |
6527766  [Phase D4.3][0.2] Codebase discovery
   |
4b76fec  [Phase D4.3][0.3] Implementation completed
   |
12956d5  Add GitHub auth documentation
   |
2520235  [Phase D4.4][0.1] Task analysis
   |
8d1374f  [Phase D4.4][0.2] Codebase discovery
   |
44d0f25  [Phase D4.4][0.3] Implementation completed
   |
2f970fd  [Phase D4.4][0.4] Testing and validation
   |
d5d1057  [Phase D4.4][0.5] Final review and docs
   |
72cb294  Update API server artifact reports         ← laboratory tip
```

---

## Summary

| Metric | Value |
|--------|-------|
| Total branches inspected | 5 (3 remote, 2 relevant local) |
| Laboratory branch identified | `origin/laboratory` |
| Commits ahead of main | 11 |
| Commits behind main | 0 |
| Secondary branch (agent/laboratory) | 13 ahead, 4 behind |
| New staging branch created | `lab-merge` (from `origin/main`) |
