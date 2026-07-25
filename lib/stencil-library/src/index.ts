/**
 * index.ts — Public API for @workspace/stencil-library
 *
 * Phase 4.5: Stencil Library
 *
 * Provides six richly-specified stencil blueprints:
 *   blog | magazine | documentation | luxury | agency | portfolio
 *
 * Each blueprint defines:
 *   - routes            — URL patterns and route metadata
 *   - hero              — hero section structural specification
 *   - cards             — card grid / listing configuration
 *   - navigation        — nav bar structural specification
 *   - footer            — footer structural specification
 *   - metadata          — display info, complexity, tags, visual keywords
 *
 * Registry:
 *   buildEnrichedRegistry()             → EnrichedStencilRegistry
 *   getBlueprint(id)                    → StencilBlueprint | undefined
 *   enumerateStencilLibraryIds()        → StencilLibraryId[]
 *   findBlueprintsByContent(types)      → StencilBlueprint[]
 *   findBlueprintsByNavigation(navs)    → StencilBlueprint[]
 *   findBlueprintsByComplexity(level)   → StencilBlueprint[]
 *   findBlueprintsByTag(terms)          → StencilBlueprint[]
 *   getAllBlueprints()                  → StencilBlueprint[]
 *
 * Resolver:
 *   resolveStencil(signals)             → ResolverResult (multi-signal ranked)
 *   resolveStencilById(id)              → StencilBlueprint (direct lookup)
 *
 * Individual blueprints (for direct import):
 *   blogBlueprint | magazineBlueprint | documentationBlueprint |
 *   luxuryBlueprint | agencyBlueprint | portfolioBlueprint
 */

// ── Registry ──────────────────────────────────────────────────────────────────

export {
  buildEnrichedRegistry,
  getBlueprint,
  enumerateStencilLibraryIds,
  findBlueprintsByContent,
  findBlueprintsByNavigation,
  findBlueprintsByComplexity,
  findBlueprintsByTag,
  getAllBlueprints,
} from "./registry.js";

// ── Resolver ─────────────────────────────────────────────────────────────────

export {
  resolveStencil,
  resolveStencilById,
} from "./resolver.js";

// ── Individual blueprints ─────────────────────────────────────────────────────

export { blogBlueprint }          from "./stencils/blog.js";
export { magazineBlueprint }      from "./stencils/magazine.js";
export { documentationBlueprint } from "./stencils/documentation.js";
export { luxuryBlueprint }        from "./stencils/luxury.js";
export { agencyBlueprint }        from "./stencils/agency.js";
export { portfolioBlueprint }     from "./stencils/portfolio.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type {
  // Stencil identity
  StencilLibraryId,

  // Full blueprint
  StencilBlueprint,

  // Route
  StencilRoute,
  CacheStrategy,

  // Hero
  HeroSpec,
  HeroVariant,
  HeroHeight,
  AnimationStyle,

  // Cards
  CardSpec,
  CardLayout,
  CardType,
  CardColumns,
  AspectRatio,
  HoverEffect,

  // Navigation
  NavSpec,
  NavStyle,
  NavPosition,
  NavBackground,
  MobileNavStyle,

  // Footer
  FooterSpec,
  FooterLayout,
  FooterLinkGroup,

  // Metadata
  StencilMetadata,
  ComplexityLevel,
  ContentDensity,

  // Registry
  EnrichedStencilRegistry,
  EnrichedRegistryStats,

  // Resolver
  ResolverSignals,
  ResolverScore,
  ResolverResult,

  // Re-exported from stencil-registry for convenience
  ContentCapability,
  LayoutCapability,
  PageTypeCapability,
  NavigationStructure,
  ContentType,
  LayoutType,
  PageType,
  ComponentType,
} from "./types.js";
