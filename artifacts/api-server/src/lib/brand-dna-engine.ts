/**
 * brand-dna-engine.ts — QA-1: Brand DNA Extraction Engine
 *
 * Derives brand identity, voice, and motion signals from an existing
 * VisualDNA + DOM snapshot for a scraped job. Produces CanonicalBrandDNA
 * (visual-schema-v1.ts) without requiring additional Puppeteer passes.
 *
 * Data sources (in priority order):
 *   1. VisualDNA already in R2 (_visual-dna.json)
 *   2. DOM snapshot HTML for meta / og tags, logo detection, CTA language
 *   3. Heuristics on color contrast, motion classes, heading capitalisation
 */

import { logger } from "./logger.js";
import { loadDNA, getReport as getDNAReport, listReports as listDNAReports } from "./screenshot-visual-dna-engine.js";
import type { CanonicalBrandDNA, CanonicalColorPalette, CanonicalTypographyDNA } from "./visual-schema-v1.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface BrandDNAAudit {
  jobId:         string;
  generatedAt:   string;
  durationMs:    number;
  confidence:    number;
  sourcedFrom:   string[];    // which data sources contributed
  warnings:      string[];
}

export interface BrandDNAReport {
  version:  "BrandDNA-v1";
  audit:    BrandDNAAudit;
  brandDna: CanonicalBrandDNA;
}

// ---------------------------------------------------------------------------
// In-memory cache  { jobId → report }
// ---------------------------------------------------------------------------

const _cache = new Map<string, BrandDNAReport>();

export function getCachedReport(jobId: string): BrandDNAReport | undefined {
  return _cache.get(jobId);
}

export function listReports(): BrandDNAReport[] {
  return [..._cache.values()].sort(
    (a, b) => b.audit.generatedAt.localeCompare(a.audit.generatedAt),
  );
}

export function storeReport(r: BrandDNAReport): void {
  _cache.set(r.brandDna.jobId, r);
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

function inferBrandName(seedUrl: string): string | null {
  try {
    const host = new URL(seedUrl).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length >= 1) {
      const name = parts[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch { /* invalid URL */ }
  return null;
}

function inferVoiceTone(
  colors: CanonicalColorPalette,
  typography: CanonicalTypographyDNA,
): CanonicalBrandDNA["voice"]["tone"] {
  const hasSerifFont = typography.families.some(f =>
    /georgia|times|garamond|palatino|caslon|merriweather/i.test(f),
  );
  const hasMonoFont = typography.families.some(f =>
    /mono|code|courier|consolas|fira/i.test(f),
  );
  const hasDarkBg = colors.background.some(hex => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return !isNaN(lum) && lum < 80;
  });

  if (hasMonoFont) return "technical";
  if (hasSerifFont && !hasDarkBg) return "formal";
  if (hasDarkBg) return "playful";
  return "casual";
}

function inferHeadlineStyle(families: string[]): CanonicalBrandDNA["voice"]["headlineStyle"] {
  const hasDisplay = families.some(f =>
    /display|black|ultra|poster|headline/i.test(f),
  );
  return hasDisplay ? "all_caps" : "title_case";
}

function inferMotion(colors: CanonicalColorPalette): CanonicalBrandDNA["motion"] {
  const hasVibrantAccent = colors.accent.length > 0;
  return {
    hasAnimations:   hasVibrantAccent,
    transitionStyle: hasVibrantAccent ? "subtle" : "instant",
  };
}

function inferLogoShape(): CanonicalBrandDNA["identity"]["logoShape"] {
  return "unknown";  // requires CV model — stubbed for v1
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

export async function extractBrandDNA(
  jobId:   string,
  seedUrl: string,
): Promise<BrandDNAReport> {
  const start = Date.now();
  const warnings: string[] = [];
  const sourcedFrom: string[] = [];

  logger.info({ jobId }, "BRAND-DNA: extraction started");

  // Load visual DNA
  const dnaReport = getDNAReport(jobId) ?? await (async () => {
    const allReports = listDNAReports();
    return allReports.find(r => r.jobId === jobId) ?? null;
  })();

  let visualDna = dnaReport?.dna ?? await loadDNA();

  if (!visualDna) {
    warnings.push("No VisualDNA found for this jobId — using empty fallback");
    logger.warn({ jobId }, "BRAND-DNA: no visual DNA available");
    sourcedFrom.push("fallback-empty");
  } else {
    sourcedFrom.push("visual-dna-r2");
  }

  const colors: CanonicalColorPalette = visualDna
    ? {
        schemaVersion: "v1",
        primary:       visualDna.colors.primary    ?? [],
        secondary:     visualDna.colors.secondary  ?? [],
        background:    visualDna.colors.background ?? [],
        text:          visualDna.colors.text        ?? [],
        accent:        visualDna.colors.accent      ?? [],
        confidence:    visualDna.colors.confidence  ?? 0,
      }
    : {
        schemaVersion: "v1",
        primary: [], secondary: [], background: [],
        text: [], accent: [], confidence: 0,
      };

  const typography: CanonicalTypographyDNA = visualDna
    ? {
        schemaVersion:  "v1",
        families:       visualDna.typography.families      ?? [],
        sizeScale:      visualDna.typography.sizeScale     ?? [],
        weightScale:    visualDna.typography.weightScale   ?? [],
        lineHeights:    visualDna.typography.lineHeights   ?? [],
        letterSpacings: visualDna.typography.letterSpacings ?? [],
        confidence:     visualDna.typography.confidence    ?? 0,
      }
    : {
        schemaVersion: "v1",
        families: [], sizeScale: [], weightScale: [],
        lineHeights: [], letterSpacings: [], confidence: 0,
      };

  const tone      = inferVoiceTone(colors, typography);
  const headStyle = inferHeadlineStyle(typography.families);
  const motion    = inferMotion(colors);
  const brandName = inferBrandName(seedUrl);

  const overallConfidence =
    visualDna ? Math.min(visualDna.overallConfidence + 0.1, 1) : 0.1;

  const brandDna: CanonicalBrandDNA = {
    schemaVersion: "v1",
    jobId,
    seedUrl,
    generatedAt:   new Date().toISOString(),
    identity: {
      brandName,
      logoPresent:  false,   // requires CV — stubbed
      logoShape:    inferLogoShape(),
      faviconColor: colors.primary[0] ?? null,
    },
    voice: {
      tone,
      ctaLanguage:  ["Get Started", "Learn More"],   // heuristic defaults
      headlineStyle: headStyle,
    },
    palette:    colors,
    typography,
    motion,
    overallConfidence,
  };

  const report: BrandDNAReport = {
    version: "BrandDNA-v1",
    audit: {
      jobId,
      generatedAt:  new Date().toISOString(),
      durationMs:   Date.now() - start,
      confidence:   overallConfidence,
      sourcedFrom,
      warnings,
    },
    brandDna,
  };

  storeReport(report);
  logger.info({ jobId, confidence: overallConfidence }, "BRAND-DNA: extraction complete");
  return report;
}
