/**
 * audit.ts — DesignDNA Audit Report generator
 *
 * Wraps extractDesignDNAWithEvidence() and annotates each detected signal
 * with a confidence tier, producing a human-readable + machine-parseable
 * audit of what was detected vs. what was defaulted.
 *
 * Usage:
 *   const report = generateAuditReport(input);
 *   console.log(report.summary.overallConfidence);   // "high" | "medium" | "low"
 *   console.log(report.summary.coveragePercent);     // 0–100
 *   saveDesignDNA(store, jobId, report.dna);
 */

import type { DesignDNA } from "./types";
import type { ExtractionInput, SignalEvidence } from "./extractor";
import { extractDesignDNAWithEvidence } from "./extractor";

// ─────────────────────────────────────────────────────────────────────────────
// Audit report types
// ─────────────────────────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low" | "default";

export interface AuditSignal extends SignalEvidence {
  /** Human-readable interpretation of this field's value. */
  explanation: string;
}

export interface AuditSection {
  section: string;
  signals: AuditSignal[];
  sectionConfidence: Confidence;
}

export interface AuditSummary {
  highCount:           number;
  mediumCount:         number;
  lowCount:            number;
  defaultCount:        number;
  totalSignals:        number;
  coverageScore:       number;
  /** 0–100 integer */
  coveragePercent:     number;
  overallConfidence:   Confidence;
  pagesAnalyzed:       number;
  totalHtmlBytes:      number;
  extractionTimeMs:    number;
}

export interface AuditReport {
  meta: {
    url:          string;
    jobId:        string;
    generatedAt:  string;
  };
  summary:  AuditSummary;
  sections: AuditSection[];
  /** The fully extracted DesignDNA — included for convenience. */
  dna:      DesignDNA;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sectionFor(field: string): string {
  const prefix = field.split(".")[0];
  const MAP: Record<string, string> = {
    typography:  "Typography",
    colors:      "Colors",
    spacing:     "Spacing",
    borders:     "Borders & Shadows",
    navigation:  "Navigation",
    hero:        "Hero",
    cards:       "Cards",
    gallery:     "Gallery",
    layout:      "Layout",
  };
  return MAP[prefix] ?? "Other";
}

function tierScore(confidence: Confidence): number {
  return confidence === "high" ? 1 : confidence === "medium" ? 0.7 : confidence === "low" ? 0.4 : 0;
}

function sectionConfidence(signals: AuditSignal[]): Confidence {
  if (!signals.length) return "default";
  const avg = signals.reduce((s, e) => s + tierScore(e.confidence), 0) / signals.length;
  return avg >= 0.7 ? "high" : avg >= 0.4 ? "medium" : avg > 0 ? "low" : "default";
}

function explain(ev: SignalEvidence): string {
  const tier = ev.confidence;
  if (tier === "high")    return `Detected with high confidence from HTML signal: "${ev.signal}". Value: ${ev.resolvedValue}.`;
  if (tier === "medium")  return `Likely value inferred from partial signal: "${ev.signal}". Value: ${ev.resolvedValue}.`;
  if (tier === "low")     return `Weak signal — "${ev.signal}" suggests ${ev.resolvedValue} but may be inaccurate.`;
  return `No signal found. Defaulted to: ${ev.resolvedValue}. Add explicit class or inline style to improve detection.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a full DesignDNA and an annotated audit report in one pass.
 *
 * @param input - Same ExtractionInput you'd pass to extractDesignDNA().
 * @returns AuditReport containing the DNA, per-signal evidence, and summary.
 */
export function generateAuditReport(input: ExtractionInput): AuditReport {
  const { dna, evidence, extractionTimeMs } = extractDesignDNAWithEvidence(input);

  // Annotate evidence with explanations
  const annotated: AuditSignal[] = evidence.map((ev) => ({
    ...ev,
    explanation: explain(ev),
  }));

  // Group into sections
  const sectionMap = new Map<string, AuditSignal[]>();
  for (const sig of annotated) {
    const sec = sectionFor(sig.field);
    if (!sectionMap.has(sec)) sectionMap.set(sec, []);
    sectionMap.get(sec)!.push(sig);
  }

  const SECTION_ORDER = ["Typography","Colors","Spacing","Borders & Shadows","Navigation","Hero","Cards","Gallery","Layout","Other"];
  const sections: AuditSection[] = SECTION_ORDER
    .filter((s) => sectionMap.has(s))
    .map((s) => {
      const sigs = sectionMap.get(s)!;
      return { section: s, signals: sigs, sectionConfidence: sectionConfidence(sigs) };
    });

  // Summary stats
  const high    = annotated.filter((e) => e.confidence === "high").length;
  const medium  = annotated.filter((e) => e.confidence === "medium").length;
  const low     = annotated.filter((e) => e.confidence === "low").length;
  const def     = annotated.filter((e) => e.confidence === "default").length;
  const total   = annotated.length || 1;

  const coverageScore   = annotated.reduce((s, e) => s + tierScore(e.confidence), 0) / total;
  const coveragePercent = Math.round(coverageScore * 100);
  const overallConfidence: Confidence =
    coverageScore >= 0.6 ? "high" : coverageScore >= 0.3 ? "medium" : "low";

  const totalHtmlBytes = input.pages.reduce((acc, p) => acc + (p.html?.length ?? 0), 0);

  return {
    meta: {
      url:         input.url,
      jobId:       input.jobId,
      generatedAt: new Date().toISOString(),
    },
    summary: {
      highCount:         high,
      mediumCount:       medium,
      lowCount:          low,
      defaultCount:      def,
      totalSignals:      total,
      coverageScore:     Math.round(coverageScore * 100) / 100,
      coveragePercent,
      overallConfidence,
      pagesAnalyzed:     input.pages.length,
      totalHtmlBytes,
      extractionTimeMs,
    },
    sections,
    dna,
  };
}
