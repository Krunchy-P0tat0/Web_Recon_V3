/**
 * compiler.ts — Main orchestrator for the Theme Intelligence Engine
 *
 * Runs all sub-engines in sequence and assembles the final DesignSystem.
 * Entry point: compileDesignSystem(siteGraph, blueprint) → DesignSystem
 *
 * All operations are:
 *   - Deterministic (same input → same output)
 *   - Pure (no I/O, no external services)
 *   - Synchronous (no async)
 */

import { createHash } from "crypto";
import type { SiteGraph } from "@workspace/site-intelligence";
import type { WebsiteBlueprint } from "@workspace/stencil-generator";
import type { DesignSystem, DesignSystemStats, ThemeProfile } from "./types";

import { classifySite }         from "./site-classifier";
import { deriveColorPalette }   from "./color-engine";
import { deriveTypographySystem } from "./typography-engine";
import { deriveDensityProfile } from "./density-engine";
import { deriveLayoutSystem }   from "./layout-engine";
import { deriveComponentStyling } from "./component-styling";
import { deriveSpacingSystem }  from "./spacing-engine";
import { generateDesignTokens } from "./token-generator";

// ---------------------------------------------------------------------------
// Deterministic ID generation
// ---------------------------------------------------------------------------

function makeDesignSystemId(siteGraphId: string, blueprintId: string): string {
  return createHash("sha256")
    .update(`theme:${siteGraphId}:${blueprintId}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Theme profile builder
// ---------------------------------------------------------------------------

function buildThemeProfile(
  system: Omit<DesignSystem, "themeProfile" | "tokens" | "stats">,
  siteGraphId: string,
  blueprintId: string,
): ThemeProfile {
  const { classification, density } = system;

  const recommendations: string[] = [];

  if (classification.confidence < 0.4) {
    recommendations.push("Site type confidence is low — consider adding clearer URL structure or page metadata to improve classification.");
  }
  if (density.density === "dense" && density.showThumbnails) {
    recommendations.push("Dense layout with thumbnails detected — ensure images are optimized to avoid layout performance issues.");
  }
  if (classification.designStrategy === "minimal") {
    recommendations.push("Minimal strategy selected — prioritize high-quality hero images as they will dominate the visual experience.");
  }
  if (classification.designStrategy === "elegant") {
    recommendations.push("Elegant strategy: use generous whitespace between sections and avoid visual clutter in navigation.");
  }
  if (classification.alternatives.length > 0 && classification.alternatives[0].confidence > 0.5) {
    const alt = classification.alternatives[0];
    recommendations.push(`Alternative site type "${alt.siteType}" scored nearly as high — review classification signals if the theme feels mismatched.`);
  }

  const summary = `${classification.primary.charAt(0).toUpperCase() + classification.primary.slice(1)} site detected with ${(classification.confidence * 100).toFixed(0)}% confidence. Design strategy: ${classification.designStrategy}. Layout strategy: ${classification.layoutStrategy}. Content density: ${density.density}. Primary color family derived from site type profile.`;

  return {
    version:       "1.0",
    generatedAt:   system.generatedAt,
    seedUrl:       system.seedUrl,
    siteGraphId,
    blueprintId,
    siteType:       classification.primary,
    confidence:     classification.confidence,
    designStrategy: classification.designStrategy,
    layoutStrategy: classification.layoutStrategy,
    contentDensity: density.density,
    classification,
    summary,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Stats builder
// ---------------------------------------------------------------------------

function buildStats(
  system: Omit<DesignSystem, "stats">,
  generationTimeMs: number,
): DesignSystemStats {
  return {
    siteType:               system.classification.primary,
    confidence:             system.classification.confidence,
    totalColorTokens:       Object.keys(system.tokens.colors.semantic).length
                          + Object.keys(system.tokens.colors.primary).length * 4,
    totalTypographyTokens:  Object.keys(system.tokens.typography.fontSizes).length * 4,
    totalSpacingTokens:     Object.keys(system.tokens.spacing).length,
    totalComponentRules:    system.componentStyling.rules.length,
    generationTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function compileDesignSystem(
  graph: SiteGraph,
  blueprint: WebsiteBlueprint,
): DesignSystem {
  const startMs    = Date.now();
  const generatedAt = new Date().toISOString();
  const id         = makeDesignSystemId(graph.id, blueprint.id);

  // Stage 1: classify the site
  const classification = classifySite(graph, blueprint);

  // Stage 2: derive all sub-systems in dependency order
  const colorPalette  = deriveColorPalette(classification);
  const typography    = deriveTypographySystem(classification);
  const density       = deriveDensityProfile(classification, graph, blueprint);
  const layout        = deriveLayoutSystem(classification, density);
  const spacing       = deriveSpacingSystem(density, layout);
  const componentStyling = deriveComponentStyling(classification, colorPalette, layout, density);

  // Stage 3: assemble design tokens
  const tokens = generateDesignTokens(classification, colorPalette, typography, spacing, layout);

  // Stage 4: assemble partial system for profile/stats
  const partial = {
    id,
    version:     "1.0" as const,
    generatedAt,
    seedUrl:     graph.seedUrl,
    siteGraphId: graph.id,
    blueprintId: blueprint.id,
    classification,
    colorPalette,
    typography,
    spacing,
    density,
    layout,
    componentStyling,
    tokens,
  };

  const themeProfile = buildThemeProfile(partial, graph.id, blueprint.id);
  const generationTimeMs = Date.now() - startMs;
  const stats = buildStats({ ...partial, themeProfile }, generationTimeMs);

  return {
    ...partial,
    themeProfile,
    stats,
  };
}
