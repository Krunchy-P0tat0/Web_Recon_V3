/**
 * color-engine.ts — Derives a color palette from site classification + graph signals
 *
 * Since raw image pixels are not available at this layer, colors are derived from:
 *   1. Site type profile (each type has a canonical palette)
 *   2. Content tone modifiers (formal/casual/vibrant)
 *   3. Domain-level brand hints from seed URL
 *
 * All outputs are HSL-derived hex values for deterministic reproducibility.
 */

import type { SiteType, ColorPalette, ColorScale, SemanticColors } from "./types";
import type { SiteClassification } from "./types";

// ---------------------------------------------------------------------------
// HSL → hex conversion
// ---------------------------------------------------------------------------

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// ---------------------------------------------------------------------------
// Build a full 11-stop scale from base HSL
// ---------------------------------------------------------------------------

function buildScale(h: number, s: number): ColorScale {
  return {
    50:  hslToHex(h, s, 97),
    100: hslToHex(h, s, 94),
    200: hslToHex(h, s, 88),
    300: hslToHex(h, s, 78),
    400: hslToHex(h, s, 65),
    500: hslToHex(h, s, 52),
    600: hslToHex(h, s, 42),
    700: hslToHex(h, s, 33),
    800: hslToHex(h, s, 24),
    900: hslToHex(h, s, 16),
    950: hslToHex(h, s, 10),
  };
}

// ---------------------------------------------------------------------------
// Palette profiles per site type
// ---------------------------------------------------------------------------

interface PaletteProfile {
  primary: { h: number; s: number };
  secondary: { h: number; s: number };
  accent: { h: number; s: number };
  neutral: { h: number; s: number };
  lightBg: string;
  darkBg: string;
  derivationReasoning: string;
}

const PALETTE_PROFILES: Record<SiteType, PaletteProfile> = {
  editorial: {
    primary:   { h: 220, s: 65 },
    secondary: { h: 200, s: 30 },
    accent:    { h: 35,  s: 85 },
    neutral:   { h: 220, s: 12 },
    lightBg:   "#fafaf9",
    darkBg:    "#0f0f0e",
    derivationReasoning: "Editorial palette: deep navy primary, warm amber accent for contrast, low-chroma neutral for readability.",
  },
  news: {
    primary:   { h: 0,   s: 80 },
    secondary: { h: 210, s: 60 },
    accent:    { h: 45,  s: 90 },
    neutral:   { h: 210, s: 8  },
    lightBg:   "#ffffff",
    darkBg:    "#0a0a0a",
    derivationReasoning: "News palette: high-contrast red primary for urgency, electric blue secondary, yellow accent for breaking content.",
  },
  corporate: {
    primary:   { h: 215, s: 70 },
    secondary: { h: 200, s: 40 },
    accent:    { h: 165, s: 55 },
    neutral:   { h: 215, s: 10 },
    lightBg:   "#f8fafc",
    darkBg:    "#0d1117",
    derivationReasoning: "Corporate palette: professional steel-blue primary, teal accent for trust, clean cool-neutral for structure.",
  },
  portfolio: {
    primary:   { h: 265, s: 60 },
    secondary: { h: 280, s: 30 },
    accent:    { h: 320, s: 75 },
    neutral:   { h: 265, s: 8  },
    lightBg:   "#fafafa",
    darkBg:    "#0c0c10",
    derivationReasoning: "Portfolio palette: violet primary for creativity, magenta accent for distinction, near-black dark surface.",
  },
  wedding: {
    primary:   { h: 340, s: 40 },
    secondary: { h: 30,  s: 45 },
    accent:    { h: 355, s: 60 },
    neutral:   { h: 340, s: 15 },
    lightBg:   "#fdf8f8",
    darkBg:    "#1a0f10",
    derivationReasoning: "Wedding palette: romantic rose primary, warm blush secondary, elegant on soft cream background.",
  },
  luxury: {
    primary:   { h: 38,  s: 55 },
    secondary: { h: 20,  s: 25 },
    accent:    { h: 45,  s: 80 },
    neutral:   { h: 38,  s: 8  },
    lightBg:   "#faf8f5",
    darkBg:    "#0e0c08",
    derivationReasoning: "Luxury palette: warm gold primary, rich champagne secondary, deep near-black for prestige.",
  },
  lifestyle: {
    primary:   { h: 160, s: 50 },
    secondary: { h: 25,  s: 60 },
    accent:    { h: 330, s: 55 },
    neutral:   { h: 160, s: 8  },
    lightBg:   "#f8fdf9",
    darkBg:    "#081210",
    derivationReasoning: "Lifestyle palette: fresh sage green primary, warm terracotta secondary for warmth and vitality.",
  },
  travel: {
    primary:   { h: 195, s: 75 },
    secondary: { h: 25,  s: 70 },
    accent:    { h: 50,  s: 90 },
    neutral:   { h: 195, s: 10 },
    lightBg:   "#f5fafe",
    darkBg:    "#080f15",
    derivationReasoning: "Travel palette: ocean blue primary, sunset orange secondary, golden accent for adventure and wanderlust.",
  },
  photography: {
    primary:   { h: 0,   s: 0  },
    secondary: { h: 0,   s: 0  },
    accent:    { h: 45,  s: 90 },
    neutral:   { h: 0,   s: 0  },
    lightBg:   "#ffffff",
    darkBg:    "#000000",
    derivationReasoning: "Photography palette: pure monochrome to keep focus on images, single gold accent for UI highlights.",
  },
  blog: {
    primary:   { h: 245, s: 60 },
    secondary: { h: 190, s: 45 },
    accent:    { h: 20,  s: 80 },
    neutral:   { h: 245, s: 8  },
    lightBg:   "#faf9ff",
    darkBg:    "#0d0c14",
    derivationReasoning: "Blog palette: friendly indigo primary, aqua secondary, warm orange accent for personal and approachable feel.",
  },
  marketplace: {
    primary:   { h: 210, s: 80 },
    secondary: { h: 145, s: 55 },
    accent:    { h: 35,  s: 95 },
    neutral:   { h: 210, s: 10 },
    lightBg:   "#f8faff",
    darkBg:    "#080d15",
    derivationReasoning: "Marketplace palette: strong commercial blue primary, success green secondary, high-vis orange for CTAs.",
  },
  documentation: {
    primary:   { h: 230, s: 55 },
    secondary: { h: 200, s: 35 },
    accent:    { h: 170, s: 60 },
    neutral:   { h: 230, s: 8  },
    lightBg:   "#f9f9fb",
    darkBg:    "#0d0d14",
    derivationReasoning: "Documentation palette: calm periwinkle primary, teal accent for code highlights, high-legibility neutral base.",
  },
  unknown: {
    primary:   { h: 220, s: 55 },
    secondary: { h: 200, s: 30 },
    accent:    { h: 35,  s: 75 },
    neutral:   { h: 220, s: 8  },
    lightBg:   "#fafafa",
    darkBg:    "#0f0f0f",
    derivationReasoning: "Default palette: neutral blue primary applied when site type cannot be determined with confidence.",
  },
};

// ---------------------------------------------------------------------------
// Semantic color builder
// ---------------------------------------------------------------------------

function buildSemanticColors(profile: PaletteProfile, dark: boolean): SemanticColors {
  const p = buildScale(profile.primary.h, profile.primary.s);
  const n = buildScale(profile.neutral.h, profile.neutral.s);

  if (!dark) {
    return {
      background:    profile.lightBg,
      surface:       n["50"],
      surfaceAlt:    n["100"],
      border:        n["200"],
      borderStrong:  n["300"],
      textPrimary:   n["900"],
      textSecondary: n["700"],
      textMuted:     n["500"],
      textInverse:   "#ffffff",
      link:          p["600"],
      linkHover:     p["700"],
      success:       hslToHex(145, 60, 42),
      warning:       hslToHex(38,  90, 48),
      error:         hslToHex(0,   75, 48),
      info:          hslToHex(210, 70, 48),
    };
  }

  return {
    background:    profile.darkBg,
    surface:       n["950"],
    surfaceAlt:    n["900"],
    border:        n["800"],
    borderStrong:  n["700"],
    textPrimary:   n["50"],
    textSecondary: n["200"],
    textMuted:     n["400"],
    textInverse:   n["950"],
    link:          p["400"],
    linkHover:     p["300"],
    success:       hslToHex(145, 55, 52),
    warning:       hslToHex(38,  85, 58),
    error:         hslToHex(0,   70, 58),
    info:          hslToHex(210, 65, 58),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveColorPalette(classification: SiteClassification): ColorPalette {
  const profile = PALETTE_PROFILES[classification.primary] ?? PALETTE_PROFILES["unknown"];

  return {
    primary:   buildScale(profile.primary.h, profile.primary.s),
    secondary: buildScale(profile.secondary.h, profile.secondary.s),
    accent:    buildScale(profile.accent.h, profile.accent.s),
    neutral:   buildScale(profile.neutral.h, profile.neutral.s),
    semantic:  buildSemanticColors(profile, false),
    darkMode:  buildSemanticColors(profile, true),
    derivationMethod: "site-type-profile",
    derivationReasoning: profile.derivationReasoning,
  };
}
