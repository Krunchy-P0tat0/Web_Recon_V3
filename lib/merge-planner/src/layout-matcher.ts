import type { DiscoveredLayout } from "@workspace/site-discovery";
import type { LayoutAssignment, LayoutType } from "@workspace/site-intelligence";
import type { EntityRef, MergeConflict, MergeDecision } from "./types.js";

let seq = 0;
const nextDecId = () => `dec-layout-${(++seq).toString().padStart(4, "0")}`;
const nextConId = () => `con-layout-${seq.toString().padStart(4, "0")}-${Date.now()}`;

// ─── Layout type → discovery name heuristics ──────────────────────────────────
//
// LayoutType values come from @workspace/site-intelligence.
// We match them against DiscoveredLayout.name via keyword scoring.

const LAYOUT_KEYWORDS: Record<LayoutType, string[]> = {
  ArticleLayout: ["article", "post", "blog-post", "blogpost", "single", "content"],
  GalleryLayout: ["gallery", "grid", "masonry", "photo", "image", "portfolio-grid"],
  LandingLayout: ["landing", "home", "hero", "marketing", "front", "splash"],
  DocumentationLayout: ["docs", "documentation", "guide", "reference", "manual", "wiki"],
  PortfolioLayout: ["portfolio", "casestudy", "case-study", "project", "work"],
  IndexLayout: ["index", "list", "archive", "category", "tag", "feed", "blog"],
  MinimalLayout: ["minimal", "simple", "bare", "clean", "empty", "shell"],
};

function scoreLayoutMatch(discoveredName: string, layoutType: LayoutType): number {
  const lower = discoveredName.toLowerCase();
  const keywords = LAYOUT_KEYWORDS[layoutType];
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 1;
  }
  // Bonus: exact suffix match e.g. "AppLayout" matches nothing, "ArticleLayout" → "ArticleLayout"
  if (lower === layoutType.toLowerCase()) score += 5;
  if (lower.endsWith(layoutType.toLowerCase().replace("layout", ""))) score += 2;
  return score;
}

function findBestDiscoveryLayoutMatch(
  layoutType: LayoutType,
  discoveredLayouts: DiscoveredLayout[]
): { layout: DiscoveredLayout; score: number } | null {
  let best: { layout: DiscoveredLayout; score: number } | null = null;
  for (const dl of discoveredLayouts) {
    const score = scoreLayoutMatch(dl.name, layoutType);
    if (score > 0 && (!best || score > best.score)) {
      best = { layout: dl, score };
    }
  }
  return best;
}

// Required structural slots per LayoutType
const LAYOUT_REQUIREMENTS: Record<LayoutType, { header: boolean; footer: boolean; nav: boolean; sidebar: boolean }> = {
  ArticleLayout:       { header: true,  footer: true,  nav: true,  sidebar: false },
  GalleryLayout:       { header: true,  footer: true,  nav: true,  sidebar: false },
  LandingLayout:       { header: true,  footer: true,  nav: true,  sidebar: false },
  DocumentationLayout: { header: true,  footer: true,  nav: true,  sidebar: true  },
  PortfolioLayout:     { header: true,  footer: true,  nav: true,  sidebar: false },
  IndexLayout:         { header: true,  footer: true,  nav: true,  sidebar: false },
  MinimalLayout:       { header: false, footer: false, nav: false, sidebar: false },
};

function slotMismatches(
  dl: DiscoveredLayout,
  required: { header: boolean; footer: boolean; nav: boolean; sidebar: boolean }
): string[] {
  const issues: string[] = [];
  if (required.header && !dl.hasHeader) issues.push("missing <header>");
  if (required.footer && !dl.hasFooter) issues.push("missing <footer>");
  if (required.nav && !dl.hasNav) issues.push("missing <nav>");
  if (required.sidebar && !dl.hasSidebar) issues.push("missing <aside/sidebar>");
  return issues;
}

// ─── Main matcher ─────────────────────────────────────────────────────────────

export interface LayoutMatchResult {
  decisions: MergeDecision[];
  conflicts: MergeConflict[];
  coveredLayoutTypes: Set<LayoutType>;
}

export function matchLayouts(
  discoveredLayouts: DiscoveredLayout[],
  layoutAssignments: LayoutAssignment[]
): LayoutMatchResult {
  seq = 0;
  const decisions: MergeDecision[] = [];
  const conflicts: MergeConflict[] = [];
  const coveredLayoutTypes = new Set<LayoutType>();

  // Count how many scraped nodes need each LayoutType
  const typeCounts = new Map<LayoutType, number>();
  for (const la of layoutAssignments) {
    typeCounts.set(la.layout, (typeCounts.get(la.layout) ?? 0) + 1);
  }

  for (const [layoutType, count] of typeCounts) {
    const match = findBestDiscoveryLayoutMatch(layoutType, discoveredLayouts);
    const required = LAYOUT_REQUIREMENTS[layoutType];

    if (!match) {
      // No existing layout can handle this content type → CREATE
      decisions.push({
        id: nextDecId(),
        action: "CREATE",
        entityKind: "layout",
        reason: `No existing layout component matches '${layoutType}'. A new layout must be created to render ${count} scraped page(s) of this type.`,
        confidence: 0.85,
        source: null,
        target: null,
        conflicts: [],
        metadata: {
          requiredLayoutType: layoutType,
          scrapedPageCount: count,
          requiredSlots: required,
        },
      });
      continue;
    }

    coveredLayoutTypes.add(layoutType);
    const mismatches = slotMismatches(match.layout, required);

    if (mismatches.length > 0) {
      // Structural slots missing → UPDATE
      const conflict: MergeConflict = {
        id: nextConId(),
        kind: "layout-mismatch",
        severity: "warning",
        description: `Discovered layout '${match.layout.name}' is mapped to '${layoutType}' but is missing required structural slots: ${mismatches.join(", ")}.`,
        sourceRef: null,
        targetRef: { id: match.layout.id, name: match.layout.name, graph: "discovery" },
        resolution: `Add the missing structural regions to '${match.layout.name}' so it can properly render '${layoutType}' content.`,
        isBlocker: false,
      };
      conflicts.push(conflict);

      decisions.push({
        id: nextDecId(),
        action: "UPDATE",
        entityKind: "layout",
        reason: `Discovered layout '${match.layout.name}' partially matches '${layoutType}' but is missing ${mismatches.length} structural slot(s). It must be updated to fully support this content type.`,
        confidence: match.score >= 3 ? 0.8 : 0.6,
        source: null,
        target: { id: match.layout.id, name: match.layout.name, path: match.layout.filePath, graph: "discovery" },
        conflicts: [conflict],
        metadata: {
          requiredLayoutType: layoutType,
          matchedLayout: match.layout.name,
          matchScore: match.score,
          missingSlots: mismatches,
          scrapedPageCount: count,
        },
      });
    } else {
      // Full structural match → EXTEND (add content routing, not structural change)
      decisions.push({
        id: nextDecId(),
        action: "EXTEND",
        entityKind: "layout",
        reason: `Discovered layout '${match.layout.name}' fully satisfies the structural requirements of '${layoutType}'. It can handle ${count} scraped page(s) via content routing.`,
        confidence: match.score >= 3 ? 0.92 : 0.75,
        source: null,
        target: { id: match.layout.id, name: match.layout.name, path: match.layout.filePath, graph: "discovery" },
        conflicts: [],
        metadata: {
          requiredLayoutType: layoutType,
          matchedLayout: match.layout.name,
          matchScore: match.score,
          scrapedPageCount: count,
        },
      });
    }
  }

  // Discovered layouts that serve no scraped LayoutType → ARCHIVE candidates
  const matchedLayoutIds = new Set<string>(
    decisions
      .filter((d) => d.target?.graph === "discovery" && d.entityKind === "layout")
      .map((d) => d.target!.id)
  );

  for (const dl of discoveredLayouts) {
    if (matchedLayoutIds.has(dl.id)) continue;
    decisions.push({
      id: nextDecId(),
      action: "ARCHIVE",
      entityKind: "layout",
      reason: `Discovered layout '${dl.name}' is not required by any scraped content type. It may be obsolete.`,
      confidence: 0.55,
      source: null,
      target: { id: dl.id, name: dl.name, path: dl.filePath, graph: "discovery" },
      conflicts: [],
      metadata: { nestingLevel: dl.nestingLevel, wrapsRouteCount: dl.wrapsRouteIds.length },
    });
  }

  return { decisions, conflicts, coveredLayoutTypes };
}
