import type { DiscoveredComponent } from "@workspace/site-discovery";
import type { LayoutAssignment, LayoutType, ContentType } from "@workspace/site-intelligence";
import type { EntityRef, MergeConflict, MergeDecision } from "./types.js";

let seq = 0;
const nextDecId = () => `dec-comp-${(++seq).toString().padStart(4, "0")}`;
const nextConId = () => `con-comp-${seq.toString().padStart(4, "0")}-${Date.now()}`;

// ─── Component inference from layout assignments ───────────────────────────────
//
// Each LayoutType requires certain UI components. We infer which components are
// needed from the set of layout assignments, then compare against what the
// codebase already provides.

interface InferredComponentNeed {
  name: string;
  usedByLayouts: LayoutType[];
  usedByContentTypes: ContentType[];
  count: number;
  isRequired: boolean;
}

const LAYOUT_COMPONENTS: Record<LayoutType, string[]> = {
  ArticleLayout:       ["ArticleHeader", "ArticleBody", "ArticleMeta", "ShareBar", "AuthorBio", "ReadingProgress"],
  GalleryLayout:       ["GalleryGrid", "GalleryItem", "LightBox", "ImageCaption", "GalleryFilter"],
  LandingLayout:       ["HeroSection", "FeatureGrid", "CallToAction", "TestimonialBlock", "PricingSection"],
  DocumentationLayout: ["TableOfContents", "DocNav", "CodeBlock", "Callout", "NextPrevNav", "DocSearch"],
  PortfolioLayout:     ["ProjectCard", "CaseStudyHeader", "ProjectGallery", "ClientCredits", "TechStack"],
  IndexLayout:         ["ArticleCard", "ContentGrid", "Pagination", "FilterBar", "CategoryBadge", "SearchBar"],
  MinimalLayout:       ["ContentBlock", "InlineMedia"],
};

const CONTENT_TYPE_COMPONENTS: Record<ContentType, string[]> = {
  ARTICLE:      ["ArticleCard", "ArticleHeader", "Breadcrumb"],
  BLOG:         ["ArticleCard", "TagList", "CategoryBadge"],
  GUIDE:        ["TableOfContents", "StepList", "Callout"],
  LANDING_PAGE: ["HeroSection", "CallToAction", "FeatureGrid"],
  PORTFOLIO:    ["ProjectCard", "ProjectGallery", "TechStack"],
  GALLERY:      ["GalleryGrid", "LightBox", "ImageCaption"],
  FAQ:          ["Accordion", "FAQSearch", "CategoryBadge"],
  DOCS:         ["CodeBlock", "DocNav", "Callout"],
};

function inferRequiredComponents(
  layoutAssignments: LayoutAssignment[]
): InferredComponentNeed[] {
  const needed = new Map<string, InferredComponentNeed>();

  for (const la of layoutAssignments) {
    const layoutComps = LAYOUT_COMPONENTS[la.layout] ?? [];
    const contentComps = CONTENT_TYPE_COMPONENTS[la.contentType] ?? [];
    const allComps = [...new Set([...layoutComps, ...contentComps])];

    for (const compName of allComps) {
      if (!needed.has(compName)) {
        needed.set(compName, {
          name: compName,
          usedByLayouts: [],
          usedByContentTypes: [],
          count: 0,
          isRequired: layoutComps.includes(compName),
        });
      }
      const entry = needed.get(compName)!;
      entry.count += 1;
      if (!entry.usedByLayouts.includes(la.layout)) entry.usedByLayouts.push(la.layout);
      if (!entry.usedByContentTypes.includes(la.contentType)) entry.usedByContentTypes.push(la.contentType);
    }
  }

  return [...needed.values()].sort((a, b) => b.count - a.count);
}

function scoreComponentMatch(
  discoveredComp: DiscoveredComponent,
  neededName: string
): number {
  const dLower = discoveredComp.name.toLowerCase();
  const nLower = neededName.toLowerCase();
  if (dLower === nLower) return 10;
  if (dLower.includes(nLower) || nLower.includes(dLower)) return 5;
  // Partial word overlap (e.g. "ArticleCard" vs "Card")
  const dWords: string[] = dLower.match(/[a-z]+/g) ?? [];
  const nWords: string[] = nLower.match(/[a-z]+/g) ?? [];
  const shared = dWords.filter((w) => nWords.includes(w) && w.length > 3);
  return shared.length;
}

function findBestDiscoveryMatch(
  neededName: string,
  discoveredComponents: DiscoveredComponent[]
): { comp: DiscoveredComponent; score: number } | null {
  let best: { comp: DiscoveredComponent; score: number } | null = null;
  for (const dc of discoveredComponents) {
    const score = scoreComponentMatch(dc, neededName);
    if (score > 0 && (!best || score > best.score)) {
      best = { comp: dc, score };
    }
  }
  return best;
}

function discoveryRef(comp: DiscoveredComponent): EntityRef {
  return { id: comp.id, name: comp.name, path: comp.filePath, graph: "discovery" };
}

// ─── Main matcher ─────────────────────────────────────────────────────────────

export interface ComponentMatchResult {
  decisions: MergeDecision[];
  conflicts: MergeConflict[];
  matchedDiscoveryCompIds: Set<string>;
}

export function matchComponents(
  discoveredComponents: DiscoveredComponent[],
  layoutAssignments: LayoutAssignment[]
): ComponentMatchResult {
  seq = 0;
  const decisions: MergeDecision[] = [];
  const conflicts: MergeConflict[] = [];
  const matchedDiscoveryCompIds = new Set<string>();

  const requiredComponents = inferRequiredComponents(layoutAssignments);

  for (const needed of requiredComponents) {
    const match = findBestDiscoveryMatch(needed.name, discoveredComponents);

    if (!match) {
      decisions.push({
        id: nextDecId(),
        action: "CREATE",
        entityKind: "component",
        reason: `Component '${needed.name}' is required by ${needed.usedByLayouts.join(", ")} for ${needed.count} scraped page(s), but no matching component exists in the codebase.`,
        confidence: needed.isRequired ? 0.9 : 0.75,
        source: null,
        target: null,
        conflicts: [],
        metadata: {
          neededName: needed.name,
          usedByLayouts: needed.usedByLayouts,
          usedByContentTypes: needed.usedByContentTypes,
          usageCount: needed.count,
          isRequired: needed.isRequired,
        },
      });
      continue;
    }

    matchedDiscoveryCompIds.add(match.comp.id);
    const isExact = match.score >= 10;

    if (isExact) {
      // Perfect name match — check prop compatibility
      decisions.push({
        id: nextDecId(),
        action: "IGNORE",
        entityKind: "component",
        reason: `Component '${match.comp.name}' exactly matches the required '${needed.name}'. No structural changes needed.`,
        confidence: 0.97,
        source: null,
        target: discoveryRef(match.comp),
        conflicts: [],
        metadata: {
          neededName: needed.name,
          matchScore: match.score,
          usageCount: needed.count,
        },
      });
    } else {
      // Partial match — check if it can be extended without breaking changes
      const conflict: MergeConflict = {
        id: nextConId(),
        kind: "component-collision",
        severity: "warning",
        description: `Component '${match.comp.name}' partially matches required '${needed.name}' (score ${match.score}/10). Props and render output may differ from what scraped content expects.`,
        sourceRef: null,
        targetRef: discoveryRef(match.comp),
        resolution: `Review '${match.comp.name}' and extend it with the additional props needed for '${needed.name}' content, or create a separate '${needed.name}' component.`,
        isBlocker: false,
      };
      conflicts.push(conflict);

      decisions.push({
        id: nextDecId(),
        action: "EXTEND",
        entityKind: "component",
        reason: `Component '${match.comp.name}' partially satisfies the requirement for '${needed.name}'. It can be extended with additional props/slots rather than creating a new component from scratch.`,
        confidence: match.score >= 5 ? 0.78 : 0.62,
        source: null,
        target: discoveryRef(match.comp),
        conflicts: [conflict],
        metadata: {
          neededName: needed.name,
          matchScore: match.score,
          existingProps: match.comp.props.map((p) => p.name),
          usageCount: needed.count,
        },
      });
    }
  }

  // Discovered components with no scraped requirement
  for (const dc of discoveredComponents) {
    if (matchedDiscoveryCompIds.has(dc.id)) continue;
    // Reusable components with no match are worth preserving (utility components)
    if (dc.isReusable && dc.usedInRouteIds.length > 0) {
      decisions.push({
        id: nextDecId(),
        action: "IGNORE",
        entityKind: "component",
        reason: `Component '${dc.name}' is a reusable component used in ${dc.usedInRouteIds.length} existing route(s). No scraped content specifically requires it, but it should be preserved.`,
        confidence: 0.9,
        source: null,
        target: discoveryRef(dc),
        conflicts: [],
        metadata: { componentType: dc.componentType, usedInRoutes: dc.usedInRouteIds.length },
      });
    } else if (!dc.isReusable) {
      decisions.push({
        id: nextDecId(),
        action: "IGNORE",
        entityKind: "component",
        reason: `Component '${dc.name}' is page-specific and not required by any scraped content layout. No action needed.`,
        confidence: 0.85,
        source: null,
        target: discoveryRef(dc),
        conflicts: [],
        metadata: { componentType: dc.componentType },
      });
    } else {
      decisions.push({
        id: nextDecId(),
        action: "ARCHIVE",
        entityKind: "component",
        reason: `Component '${dc.name}' exists in the codebase but is not required by any scraped content layout and has no active route usage. It may be obsolete.`,
        confidence: 0.5,
        source: null,
        target: discoveryRef(dc),
        conflicts: [],
        metadata: { componentType: dc.componentType },
      });
    }
  }

  return { decisions, conflicts, matchedDiscoveryCompIds };
}
