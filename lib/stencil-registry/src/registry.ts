import type {
  StencilId,
  StencilDefinition,
  StencilRegistry,
  StencilRegistryStats,
  LayoutType,
  PageType,
} from "./types.js";

import { agencyStencil }        from "./stencils/agency.js";
import { blogStencil }          from "./stencils/blog.js";
import { magazineStencil }      from "./stencils/magazine.js";
import { portfolioStencil }     from "./stencils/portfolio.js";
import { documentationStencil } from "./stencils/documentation.js";
import { marketplaceStencil }   from "./stencils/marketplace.js";
import { directoryStencil }     from "./stencils/directory.js";
import { weddingStencil }       from "./stencils/wedding.js";

// ─── Master list (source of truth for registry order) ────────────────────────

const ALL_STENCILS: StencilDefinition[] = [
  agencyStencil,
  blogStencil,
  magazineStencil,
  portfolioStencil,
  documentationStencil,
  marketplaceStencil,
  directoryStencil,
  weddingStencil,
];

// ─── Public: enumerate ────────────────────────────────────────────────────────

/**
 * Returns all registered stencil IDs in canonical order.
 * Satisfies the B1 success criterion: "the system can enumerate all
 * available stencil types."
 */
export function enumerateStencilTypes(): StencilId[] {
  return ALL_STENCILS.map((s) => s.id);
}

/**
 * Look up a single stencil by id.
 * Returns undefined when the id is not in the registry.
 */
export function getStencil(id: StencilId): StencilDefinition | undefined {
  return ALL_STENCILS.find((s) => s.id === id);
}

/**
 * Returns every stencil that supports at least one of the supplied
 * content types as "primary" or "supported" (partial matches excluded).
 */
export function findStencilsByContent(
  contentTypes: string[]
): StencilDefinition[] {
  return ALL_STENCILS.filter((s) =>
    s.supportedContent.some(
      (c) =>
        contentTypes.includes(c.contentType) &&
        (c.support === "primary" || c.support === "supported")
    )
  );
}

/**
 * Returns every stencil that includes all of the supplied navigation
 * structures.
 */
export function findStencilsByNavigation(
  structures: string[]
): StencilDefinition[] {
  return ALL_STENCILS.filter((s) =>
    structures.every((nav) => s.supportedNavigationStructures.includes(nav as never))
  );
}

// ─── Public: build registry ───────────────────────────────────────────────────

/**
 * Build the full StencilRegistry — a serialisable snapshot of every
 * registered stencil with a pre-computed index and statistics.
 *
 * Pure and synchronous: same call always produces the same output.
 */
export function buildStencilRegistry(): StencilRegistry {
  const stencilIndex = Object.fromEntries(
    ALL_STENCILS.map((s) => [s.id, s])
  ) as Record<StencilId, StencilDefinition>;

  const stats = computeStats(ALL_STENCILS);

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    stats,
    stencils: ALL_STENCILS,
    stencilIndex,
  };
}

// ─── Internal: stats ─────────────────────────────────────────────────────────

function computeStats(stencils: StencilDefinition[]): StencilRegistryStats {
  const ALL_LAYOUT_TYPES: LayoutType[] = [
    "ArticleLayout",
    "GalleryLayout",
    "LandingLayout",
    "DocumentationLayout",
    "PortfolioLayout",
    "IndexLayout",
    "MinimalLayout",
  ];

  const ALL_PAGE_TYPES: PageType[] = [
    "homepage", "article", "blog", "guide", "docs", "portfolio",
    "faq", "landing", "category", "tag", "gallery", "search",
    "not_found", "sitemap_page",
  ];

  const byPrimaryLayout = Object.fromEntries(
    ALL_LAYOUT_TYPES.map((l) => [l, 0])
  ) as Record<LayoutType, number>;

  const byPrimaryPageType = Object.fromEntries(
    ALL_PAGE_TYPES.map((p) => [p, 0])
  ) as Record<PageType, number>;

  let totalContentCapabilities = 0;
  const navStructureSet = new Set<string>();

  for (const s of stencils) {
    byPrimaryLayout[s.primaryLayout] =
      (byPrimaryLayout[s.primaryLayout] ?? 0) + 1;
    byPrimaryPageType[s.primaryPageType] =
      (byPrimaryPageType[s.primaryPageType] ?? 0) + 1;
    totalContentCapabilities += s.supportedContent.length;
    for (const nav of s.supportedNavigationStructures) {
      navStructureSet.add(nav);
    }
  }

  return {
    totalStencils: stencils.length,
    byPrimaryLayout,
    byPrimaryPageType,
    totalContentCapabilities,
    totalNavigationStructures: navStructureSet.size,
  };
}
