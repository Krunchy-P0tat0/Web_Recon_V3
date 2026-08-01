/**
 * registry.ts — Phase 4.5 Enriched Stencil Registry
 *
 * Assembles all six StencilBlueprint definitions into an EnrichedStencilRegistry
 * with a pre-computed index and statistics.
 *
 * Pure and synchronous — same call always produces the same output.
 */

import type {
  StencilLibraryId,
  StencilBlueprint,
  EnrichedStencilRegistry,
  EnrichedRegistryStats,
  ComplexityLevel,
  ContentDensity,
} from "./types.js";

import { blogBlueprint }          from "./stencils/blog.js";
import { magazineBlueprint }      from "./stencils/magazine.js";
import { documentationBlueprint } from "./stencils/documentation.js";
import { luxuryBlueprint }        from "./stencils/luxury.js";
import { agencyBlueprint }        from "./stencils/agency.js";
import { portfolioBlueprint }     from "./stencils/portfolio.js";

// ── Master list ────────────────────────────────────────────────────────────────

const ALL_BLUEPRINTS: StencilBlueprint[] = [
  blogBlueprint,
  magazineBlueprint,
  documentationBlueprint,
  luxuryBlueprint,
  agencyBlueprint,
  portfolioBlueprint,
];

// ── Stats computation ─────────────────────────────────────────────────────────

function computeStats(blueprints: StencilBlueprint[]): EnrichedRegistryStats {
  const COMPLEXITY_LEVELS: ComplexityLevel[] = ["simple", "moderate", "complex"];
  const DENSITY_LEVELS: ContentDensity[]     = ["sparse", "moderate", "dense"];

  const byComplexity = Object.fromEntries(
    COMPLEXITY_LEVELS.map((c) => [c, 0])
  ) as Record<ComplexityLevel, number>;

  const byContentDensity = Object.fromEntries(
    DENSITY_LEVELS.map((d) => [d, 0])
  ) as Record<ContentDensity, number>;

  let totalRoutes              = 0;
  let totalRequiredComponents  = 0;
  let stencilsWithSidebar      = 0;
  let stencilsWithMegaMenu     = 0;
  let stencilsWithNewsletter   = 0;

  for (const bp of blueprints) {
    totalRoutes             += bp.routes.length;
    totalRequiredComponents += bp.requiredComponents.length;

    if (bp.navigation.hasPersistentSidebar) stencilsWithSidebar++;
    if (bp.supportedNavigationStructures.includes("mega-menu")) stencilsWithMegaMenu++;
    if (bp.footer.hasNewsletter) stencilsWithNewsletter++;

    byComplexity[bp.metadata.complexity]         = (byComplexity[bp.metadata.complexity] ?? 0) + 1;
    byContentDensity[bp.metadata.contentDensity] = (byContentDensity[bp.metadata.contentDensity] ?? 0) + 1;
  }

  return {
    totalStencils: blueprints.length,
    totalRoutes,
    totalRequiredComponents,
    stencilsWithSidebar,
    stencilsWithMegaMenu,
    stencilsWithNewsletter,
    byComplexity,
    byContentDensity,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * buildEnrichedRegistry — assembles all blueprints into a serialisable
 * EnrichedStencilRegistry with a pre-computed index and statistics.
 *
 * Pure and synchronous.
 */
export function buildEnrichedRegistry(): EnrichedStencilRegistry {
  const index = Object.fromEntries(
    ALL_BLUEPRINTS.map((bp) => [bp.id, bp])
  ) as Record<StencilLibraryId, StencilBlueprint>;

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    stats: computeStats(ALL_BLUEPRINTS),
    blueprints: ALL_BLUEPRINTS,
    index,
  };
}

/**
 * getBlueprint — look up a single blueprint by StencilLibraryId.
 * Returns undefined when the id is not in the library.
 */
export function getBlueprint(id: StencilLibraryId): StencilBlueprint | undefined {
  return ALL_BLUEPRINTS.find((bp) => bp.id === id);
}

/**
 * enumerateStencilLibraryIds — returns all registered ids in canonical order.
 */
export function enumerateStencilLibraryIds(): StencilLibraryId[] {
  return ALL_BLUEPRINTS.map((bp) => bp.id);
}

/**
 * findBlueprintsByContent — returns blueprints that support at least one of
 * the supplied content types as "primary" or "supported".
 */
export function findBlueprintsByContent(contentTypes: string[]): StencilBlueprint[] {
  return ALL_BLUEPRINTS.filter((bp) =>
    bp.supportedContent.some(
      (c) =>
        contentTypes.includes(c.contentType) &&
        (c.support === "primary" || c.support === "supported")
    )
  );
}

/**
 * findBlueprintsByNavigation — returns blueprints that include all of the
 * supplied navigation structures.
 */
export function findBlueprintsByNavigation(structures: string[]): StencilBlueprint[] {
  return ALL_BLUEPRINTS.filter((bp) =>
    structures.every((nav) =>
      bp.supportedNavigationStructures.includes(nav as never)
    )
  );
}

/**
 * findBlueprintsByComplexity — returns blueprints at a given complexity level.
 */
export function findBlueprintsByComplexity(
  complexity: ComplexityLevel
): StencilBlueprint[] {
  return ALL_BLUEPRINTS.filter((bp) => bp.metadata.complexity === complexity);
}

/**
 * findBlueprintsByTag — returns blueprints whose metadata tags include any
 * of the supplied search terms (case-insensitive).
 */
export function findBlueprintsByTag(terms: string[]): StencilBlueprint[] {
  const lower = terms.map((t) => t.toLowerCase());
  return ALL_BLUEPRINTS.filter((bp) =>
    bp.metadata.tags.some((tag) => lower.includes(tag.toLowerCase())) ||
    bp.metadata.visualKeywords.some((kw) => lower.includes(kw.toLowerCase()))
  );
}

/**
 * getAllBlueprints — returns the master list in canonical order.
 */
export function getAllBlueprints(): StencilBlueprint[] {
  return [...ALL_BLUEPRINTS];
}
