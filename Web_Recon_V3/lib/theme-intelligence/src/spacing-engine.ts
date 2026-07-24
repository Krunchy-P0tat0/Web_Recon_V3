/**
 * spacing-engine.ts — Derives spacing system from density profile
 *
 * Generates a full spacing scale and semantic layout dimensions.
 * All values are in rem/px for CSS compatibility.
 */

import type { DensityProfile, SpacingSystem, SpacingScale, SpacingDensity } from "./types";
import type { LayoutSystem } from "./types";

// ---------------------------------------------------------------------------
// Base scale multipliers per density
// ---------------------------------------------------------------------------

const DENSITY_MULTIPLIERS: Record<SpacingDensity, number> = {
  compact:     0.85,
  default:     1.0,
  comfortable: 1.15,
  spacious:    1.3,
};

// ---------------------------------------------------------------------------
// Map content density → spacing density
// ---------------------------------------------------------------------------

function resolveSpacingDensity(density: DensityProfile): SpacingDensity {
  if (density.density === "dense")    return "compact";
  if (density.density === "visual")   return "spacious";
  return "default";
}

// ---------------------------------------------------------------------------
// Build spacing scale
// ---------------------------------------------------------------------------

function buildSpacingScale(multiplier: number): SpacingScale {
  const base = (n: number) => `${(n * multiplier).toFixed(3).replace(/\.?0+$/, "")}rem`;
  return {
    px:   "1px",
    0.5:  base(0.125),
    1:    base(0.25),
    2:    base(0.5),
    3:    base(0.75),
    4:    base(1),
    5:    base(1.25),
    6:    base(1.5),
    8:    base(2),
    10:   base(2.5),
    12:   base(3),
    16:   base(4),
    20:   base(5),
    24:   base(6),
    32:   base(8),
    40:   base(10),
    48:   base(12),
    64:   base(16),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveSpacingSystem(
  density: DensityProfile,
  layout: LayoutSystem,
): SpacingSystem {
  const spacingDensity = resolveSpacingDensity(density);
  const multiplier = DENSITY_MULTIPLIERS[spacingDensity];
  const scale = buildSpacingScale(multiplier);

  const sectionPad = density.density === "dense" ? scale[12] : density.density === "visual" ? scale[24] : scale[16];
  const cardPad    = density.density === "dense" ? scale[4]  : density.density === "visual" ? scale[8]  : scale[6];

  return {
    density: spacingDensity,
    scale,
    containerMaxWidth:      layout.sidebarWidth ? layout.sidebarWidth.replace("280", "1200") : "1200px",
    contentMaxWidth:        "72ch",
    sectionVerticalPadding: sectionPad,
    cardPadding:            cardPad,
    gridGap:                layout.grid.gutterWidth,
    derivationReasoning:    `Spacing density "${spacingDensity}" derived from content density "${density.density}". Multiplier: ${multiplier}x base scale.`,
  };
}
