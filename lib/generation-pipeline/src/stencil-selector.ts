import {
  buildStencilRegistry,
  findStencilsByContent,
  getStencil,
} from "@workspace/stencil-registry";
import type { ContentType, StencilDefinition } from "@workspace/stencil-registry";
import type { SiteGraph } from "@workspace/site-intelligence";
import type { StencilSelectionResult, StencilScore } from "./types.js";

const SUPPORT_WEIGHTS = {
  primary: 3,
  supported: 2,
  partial: 1,
} as const;

const FALLBACK_STENCIL = "blog" as const;

// ---------------------------------------------------------------------------
// selectStencil — picks the best-fit stencil for a SiteGraph
// ---------------------------------------------------------------------------

export function selectStencil(siteGraph: SiteGraph): StencilSelectionResult {
  // Tally content type frequencies from classification results
  const typeCounts = new Map<ContentType, number>();
  for (const cls of siteGraph.classifications) {
    typeCounts.set(cls.contentType, (typeCounts.get(cls.contentType) ?? 0) + 1);
  }
  const contentTypes = [...typeCounts.keys()];

  // Find stencil candidates matching our content types
  const candidates =
    contentTypes.length > 0
      ? findStencilsByContent(contentTypes)
      : buildStencilRegistry().stencils;

  if (candidates.length === 0) {
    const fallback = getStencil(FALLBACK_STENCIL);
    return {
      selectedStencilId: FALLBACK_STENCIL,
      selectedStencilName: fallback?.displayName ?? "Blog",
      candidateCount: 0,
      selectionReason: "No matching stencils found — defaulted to blog",
      scores: [],
    };
  }

  // Score and rank
  const scores: StencilScore[] = candidates
    .map((s) => scoreStencil(s, typeCounts))
    .sort((a, b) => b.score - a.score);

  const winner = scores[0]!;
  const winnerDef = getStencil(winner.stencilId as Parameters<typeof getStencil>[0]);

  return {
    selectedStencilId: winner.stencilId,
    selectedStencilName: winnerDef?.displayName ?? winner.stencilId,
    candidateCount: candidates.length,
    selectionReason: winner.reason,
    scores,
  };
}

// ---------------------------------------------------------------------------
// Scoring — weighted coverage of content types per stencil
// ---------------------------------------------------------------------------

function scoreStencil(
  stencil: StencilDefinition,
  typeCounts: Map<ContentType, number>
): StencilScore {
  let rawScore = 0;
  let maxScore = 0;
  const matched: string[] = [];

  for (const [contentType, count] of typeCounts) {
    const cap = stencil.supportedContent.find((c) => c.contentType === contentType);
    const weight = cap ? (SUPPORT_WEIGHTS[cap.support] ?? 0) : 0;
    rawScore += weight * count;
    maxScore += SUPPORT_WEIGHTS.primary * count;
    if (weight > 0) {
      matched.push(`${String(contentType)}(${cap!.support})`);
    }
  }

  const score = maxScore > 0 ? rawScore / maxScore : 0;

  return {
    stencilId: stencil.id,
    score: Math.round(score * 1000) / 1000,
    reason:
      matched.length > 0
        ? `Matched: ${matched.slice(0, 4).join(", ")}`
        : "No direct content type match — lowest-weight candidate",
  };
}
