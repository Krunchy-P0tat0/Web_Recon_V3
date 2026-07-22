#!/usr/bin/env bash
# scripts/sync-docs.sh
#
# Commits and force-pushes the three living project documents to GitHub so they
# are always available when starting a new Replit session. Run this any time you
# update PROJECT_STATUS.md, PROJECT_PLAN.md, or ARCHITECTURE_INDEX.md.
#
# Usage: bash scripts/sync-docs.sh [optional commit message suffix]
#
# Requirements: GITHUB_PERSONAL_ACCESS_TOKEN must be set in the environment.

set -euo pipefail

REPO_URL="https://Krunchy-P0tat0:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/Krunchy-P0tat0/Web_Recon_V3.git"
DOCS=("PROJECT_STATUS.md" "PROJECT_PLAN.md" "ARCHITECTURE_INDEX.md")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MSG_SUFFIX="${1:-}"

# Ensure we are at the workspace root
cd "$(git rev-parse --show-toplevel)"

# Stage only the three docs (never touch other files)
git add "${DOCS[@]}"

# Only commit if there are staged changes
if git diff --cached --quiet; then
  echo "[sync-docs] No changes to docs — nothing to commit."
else
  COMMIT_MSG="docs: sync living docs @ ${TIMESTAMP}${MSG_SUFFIX:+ — $MSG_SUFFIX}"
  git commit -m "$COMMIT_MSG"
  echo "[sync-docs] Committed: $COMMIT_MSG"
fi

# Push to GitHub
git push "$REPO_URL" main
echo "[sync-docs] Pushed to GitHub: Krunchy-P0tat0/Web_Recon_V3 main"
