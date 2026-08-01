/**
 * stencil-contract.ts — Stencil Compatibility Layer
 *
 * Defines the formal contract between the Site Intelligence Layer and
 * any future StencilRenderer implementation.
 *
 * Core guarantee:
 *   A renderer that satisfies this contract MUST be able to produce
 *   a complete website from ONLY a SiteGraph — with no access to:
 *     - The original crawled website
 *     - The crawler or scraper
 *     - The database
 *     - Any external network service
 *
 * This file contains:
 *   - StencilContract constant (the canonical contract definition)
 *   - Type guards and helpers for contract validation
 *   - RendererManifest interface (what a renderer declares about itself)
 */

import type {
  SiteGraph,
  StencilContract,
  StencilCapability,
  StencilRendererRequirement,
  StencilOutputSpec,
} from "./types";

// ---------------------------------------------------------------------------
// Canonical StencilContract definition
// ---------------------------------------------------------------------------

export const STENCIL_CONTRACT: StencilContract = {
  version: "1.0",
  name: "SiteIntelligenceStencilContract",
  description:
    "A renderer satisfying this contract consumes only a SiteGraph and " +
    "produces a complete, self-contained website with no external dependencies.",

  rendererRequirements: {
    input: "SiteGraph",
    version: "1.0",
    requiredFields: [
      "id",
      "version",
      "seedUrl",
      "manifestId",
      "classifications",
      "navigation",
      "routeMap",
      "layoutAssignments",
      "assetGraph",
      "stats",
    ],
    optionalFields: ["categoryGraph"],
  } satisfies StencilRendererRequirement,

  capabilities: [
    "render_article",
    "render_gallery",
    "render_landing",
    "render_documentation",
    "render_portfolio",
    "render_index",
    "render_navigation",
    "render_breadcrumbs",
    "render_category_pages",
    "embed_assets",
    "generate_sitemap",
    "generate_search_index",
  ] satisfies StencilCapability[],

  outputSpec: {
    htmlFiles: true,
    cssFiles: true,
    assetFiles: true,
    rootIndex: true,
    sitemap: true,
    searchIndex: true,
  } satisfies StencilOutputSpec,

  constraints: {
    noCrawlerDependency: true,
    noDatabaseDependency: true,
    noExternalNetworkRequired: true,
    noOriginalSiteDependency: true,
    deterministicOutput: true,
  },

  siteGraphVersion: "1.0",
};

// ---------------------------------------------------------------------------
// RendererManifest — declaration from a renderer about its capabilities
// ---------------------------------------------------------------------------

export interface RendererCapabilityReport {
  name: string;
  version: string;
  contractVersion: string;
  supportedLayouts: string[];
  supportedCapabilities: StencilCapability[];
  missingCapabilities: StencilCapability[];
  contractSatisfied: boolean;
  satisfactionGrade: "FULL" | "PARTIAL" | "INCOMPATIBLE";
  incompatibilityReasons: string[];
}

// ---------------------------------------------------------------------------
// Contract validation helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a SiteGraph object satisfies the minimum structural
 * requirements to be consumed by a StencilRenderer.
 */
export function validateSiteGraphForRendering(graph: SiteGraph): {
  valid: boolean;
  missingFields: string[];
  warnings: string[];
} {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  const required = STENCIL_CONTRACT.rendererRequirements.requiredFields;
  for (const field of required) {
    const value = graph[field as keyof SiteGraph];
    if (value === undefined || value === null) {
      missingFields.push(field);
    }
  }

  if (graph.totalNodes === 0) {
    warnings.push("SiteGraph has zero nodes — renderer will produce an empty site.");
  }
  if (graph.contentNodes === 0) {
    warnings.push("No content nodes — renderer may only produce an empty index.");
  }
  if (graph.routeMap.collisionCount > 0) {
    warnings.push(
      `${graph.routeMap.collisionCount} route collision(s) detected — collision-resolved routes have numeric suffixes.`
    );
  }
  if (graph.navigation.orphanPages.length > 0) {
    warnings.push(
      `${graph.navigation.orphanPages.length} orphan page(s) — these may not appear in navigation.`
    );
  }
  if (graph.assetGraph.missingAssets.length > 0) {
    warnings.push(
      `${graph.assetGraph.missingAssets.length} missing asset(s) — renderer will encounter broken references.`
    );
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
    warnings,
  };
}

/**
 * Checks whether a renderer declares the minimum set of capabilities
 * required by the canonical StencilContract.
 */
export function evaluateRendererCapabilities(
  rendererName: string,
  rendererVersion: string,
  declaredCapabilities: StencilCapability[]
): RendererCapabilityReport {
  const declaredSet = new Set(declaredCapabilities);
  const required = STENCIL_CONTRACT.capabilities;

  const missingCapabilities = required.filter((c) => !declaredSet.has(c));
  const contractSatisfied = missingCapabilities.length === 0;

  let satisfactionGrade: RendererCapabilityReport["satisfactionGrade"];
  let incompatibilityReasons: string[] = [];

  if (contractSatisfied) {
    satisfactionGrade = "FULL";
  } else if (missingCapabilities.length <= 3) {
    satisfactionGrade = "PARTIAL";
    incompatibilityReasons = missingCapabilities.map(
      (c) => `Missing capability: ${c}`
    );
  } else {
    satisfactionGrade = "INCOMPATIBLE";
    incompatibilityReasons = [
      `Missing ${missingCapabilities.length} of ${required.length} required capabilities.`,
      ...missingCapabilities.map((c) => `  - ${c}`),
    ];
  }

  const supportedLayouts = [
    "ArticleLayout",
    "GalleryLayout",
    "LandingLayout",
    "DocumentationLayout",
    "PortfolioLayout",
    "IndexLayout",
    "MinimalLayout",
  ];

  return {
    name: rendererName,
    version: rendererVersion,
    contractVersion: STENCIL_CONTRACT.version,
    supportedLayouts,
    supportedCapabilities: declaredCapabilities,
    missingCapabilities,
    contractSatisfied,
    satisfactionGrade,
    incompatibilityReasons,
  };
}
