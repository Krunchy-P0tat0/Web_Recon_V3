# Known Issues — WebRecon API Server

The following TypeScript errors were found by GitHub Actions on `lab-merge`.
They are intentionally not fixed yet. They will be assigned to the Kimi bridge later.

## api-server typecheck errors

- [ ] `src/lib/db-queue.ts(16,3)` — Missing properties `crawlAllPages`, `coverageThreshold`
- [ ] `src/lib/differential-execution-planner.ts(25,15)` — `ListJobsFn` not exported from `./diff-engine.js`
- [ ] `src/lib/differential-execution-planner.ts(515,36)` — Property `stage` missing on `JobCheckpoint`
- [ ] `src/lib/disaster-recovery-engine-e4.ts` — Multiple errors: `"WARN"` not assignable to `"PASS" | "FAIL" | "SKIP"`
- [ ] `src/lib/job-dashboard.ts(365,34)` — Property `trackedJobs` missing on `JobHealthReport`
- [ ] `src/lib/job-dashboard.ts(399,34)` — same
- [ ] `src/lib/master-orchestrator.ts(223,11)` — `name` possibly `undefined` in `ExecutionStage`
- [ ] `src/lib/production-certification-engine-e5.ts(238,22)` — `default` missing on `http` import
- [ ] `src/lib/r2-stage-persister.ts(152,7)` — `"retrying"` not assignable to stage status type
- [ ] `src/lib/self-healing-orchestrator.ts` — Multiple `supervisorCycles`, `trackedJobs` missing
- [ ] `src/routes/progress.ts` — `string | string[]` not assignable to `string`

## Next actions

- Connect Kimi to fix these errors via the Worker bridge.
- Re-enable `api-server` typecheck in `.github/workflows/labs-validation.yml` after fixes.