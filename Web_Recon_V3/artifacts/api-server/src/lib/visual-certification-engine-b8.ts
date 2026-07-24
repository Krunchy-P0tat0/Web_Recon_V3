/**
 * visual-certification-engine-b8.ts — Phase B8: Visual Reconstruction Certification
 *
 * Aggregates all upstream fidelity signals and issues a final production-grade
 * certification of a Website Prime reconstruction.
 *
 * Evaluated dimensions (9 total):
 *   Navigation · Layout · Typography · Spacing · Responsive ·
 *   Component · Image · Interaction · Pixel
 *
 * Certification grades:
 *   A+  ≥ 95  — near-perfect, production-ready with no material deficiencies
 *   A   ≥ 85  — high quality, minor visual differences only
 *   B   ≥ 70  — good, some visible differences, non-blocking
 *   C   ≥ 55  — acceptable, notable differences, review recommended
 *   FAIL < 55 — significant deficiencies, not production-ready
 *
 * Outputs (disk + R2 under jobs/{sourceJobId}/b8/):
 *   visual-certification-report.json
 *   visual-grade.json
 *   visual-readiness-report.json
 *
 * Pipeline placement: after PF-1/PF-2/VR-6/VR-7/B6 → B8 certification
 */

import { writeFile } from "fs/promises";
import { join }      from "path";
import { logger }    from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { VisualFidelityReport }  from "./visual-fidelity-engine.js";
import type { PixelComparisonReport, PerceptualScore } from "./pixel-comparison-engine.js";
import type { ComponentErrorReport }  from "./visual-diff-localizer.js";
import type { ConsistencyReport }     from "./consistency-engine-vr6.js";
import type { TypographyFidelityReport } from "./typography-fidelity-engine.js";

// ---------------------------------------------------------------------------
// Types — Certification grade
// ---------------------------------------------------------------------------

export type CertGrade = "A+" | "A" | "B" | "C" | "FAIL";

export interface DimensionScore {
  dimension:    string;
  score:        number;          // 0–100
  weight:       number;          // 0–1 (contribution to overall)
  grade:        CertGrade;
  confidence:   number;          // 0–1 (data completeness)
  sources:      string[];        // which sub-reports contributed
  issues:       string[];        // specific deficiencies
}

export interface VisualDeficiency {
  dimension:    string;
  severity:     "blocking" | "major" | "minor";
  description:  string;
  impact:       string;          // what it prevents at production
  fix:          string;          // remediation path
}

// ---------------------------------------------------------------------------
// Types — visual-certification-report.json
// ---------------------------------------------------------------------------

export interface VisualCertificationReport {
  schemaVersion:   "B8-1";
  sourceJobId:     string;
  generatedJobId:  string;
  certifiedAt:     string;
  durationMs:      number;
  overallScore:    number;        // 0–100, weighted composite
  grade:           CertGrade;
  productionReady: boolean;       // true when grade is A+, A, or B
  dimensions:      DimensionScore[];
  deficiencies:    VisualDeficiency[];
  dataCompleteness: {
    hasPixelComparison:   boolean;
    hasPerceptualScore:   boolean;
    hasComponentReport:   boolean;
    hasConsistencyReport: boolean;
    hasTypographyReport:  boolean;
    hasFidelityReport:    boolean;
    overallCompleteness:  number;  // 0–1
  };
  r2Keys: {
    report:    string | null;
    grade:     string | null;
    readiness: string | null;
  };
}

// ---------------------------------------------------------------------------
// Types — visual-grade.json
// ---------------------------------------------------------------------------

export interface VisualGrade {
  schemaVersion:   "B8-1";
  sourceJobId:     string;
  generatedJobId:  string;
  certifiedAt:     string;
  overallScore:    number;
  grade:           CertGrade;
  productionReady: boolean;
  dimensionSummary: Record<string, { score: number; grade: CertGrade }>;
  topDeficiencies:  string[];
  certificationId:  string;
}

// ---------------------------------------------------------------------------
// Types — visual-readiness-report.json
// ---------------------------------------------------------------------------

export type ReadinessStatus = "ready" | "conditional" | "blocked";

export interface ReadinessCheck {
  name:        string;
  status:      "pass" | "warn" | "fail";
  description: string;
  detail:      string;
}

export interface VisualReadinessReport {
  schemaVersion:   "B8-1";
  sourceJobId:     string;
  generatedJobId:  string;
  certifiedAt:     string;
  readinessStatus: ReadinessStatus;
  overallScore:    number;
  grade:           CertGrade;
  checks:          ReadinessCheck[];
  blockingIssues:  VisualDeficiency[];
  majorIssues:     VisualDeficiency[];
  minorIssues:     VisualDeficiency[];
  nextSteps:       string[];
  estimatedFixTime: string;       // human-readable estimate
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface CertificationInput {
  sourceJobId:    string;
  generatedJobId: string;
  /** Pre-computed sub-reports — any subset may be omitted */
  fidelityReport?:     VisualFidelityReport;
  pixelReport?:        PixelComparisonReport;
  perceptualScore?:    PerceptualScore;
  componentReport?:    ComponentErrorReport;
  consistencyReport?:  ConsistencyReport;
  typographyReport?:   TypographyFidelityReport;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface StoredCert {
  report:    VisualCertificationReport;
  grade:     VisualGrade;
  readiness: VisualReadinessReport;
}

const _store = new Map<string, StoredCert>();

function storeKey(s: string, g: string) { return `${s}::${g}`; }

export function getCertification(src: string, gen: string): StoredCert | undefined {
  return _store.get(storeKey(src, gen));
}

export function listCertifications(): Array<{
  sourceJobId: string; generatedJobId: string;
  grade: CertGrade; overallScore: number; productionReady: boolean; certifiedAt: string;
}> {
  return [..._store.values()].map(c => ({
    sourceJobId:    c.report.sourceJobId,
    generatedJobId: c.report.generatedJobId,
    grade:          c.report.grade,
    overallScore:   c.report.overallScore,
    productionReady: c.report.productionReady,
    certifiedAt:    c.report.certifiedAt,
  }));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function certGrade(score: number): CertGrade {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "FAIL";
}

function ssimToScore(ssim: number): number {
  // SSIM 0.9 → ~100, 0.5 → ~0, with a gentle curve
  return clamp(Math.round(((ssim - 0.5) / 0.5) * 100));
}

function grade4ToScore(g: "A" | "B" | "C" | "D" | "F"): number {
  return g === "A" ? 92 : g === "B" ? 79 : g === "C" ? 65 : g === "D" ? 50 : 30;
}

// ---------------------------------------------------------------------------
// Dimension scorers
// ---------------------------------------------------------------------------

function scoreNavigation(
  fid?: VisualFidelityReport,
  cons?: ConsistencyReport,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 75; // fallback when data is absent
  let confidence = 0.3;

  const navFid  = fid?.summary.metrics.navigation;
  const consOv  = cons?.metrics.overallConsistency;

  if (navFid !== undefined) { sources.push("VR-7"); confidence += 0.3; }
  if (consOv  !== undefined) { sources.push("VR-6"); confidence += 0.2; }

  if (navFid !== undefined && consOv !== undefined) {
    score = clamp(navFid * 0.6 + consOv * 0.4);
  } else if (navFid !== undefined) {
    score = clamp(navFid);
  } else if (consOv !== undefined) {
    score = clamp(consOv);
  }

  // Check consistency issues
  if (cons) {
    const navErrors = cons.issues.filter(i =>
      i.kind === "missing_global_nav" || i.kind === "nav_placement_mismatch",
    );
    if (navErrors.length > 0) {
      issues.push(`${navErrors.length} navigation consistency issue(s) detected`);
      score = clamp(score - navErrors.length * 5);
    }
    if (cons.summary.issueBySeverity.error > 2) {
      issues.push("Multiple critical consistency violations in navigation");
    }
  }

  if (score < 70) issues.push("Navigation fidelity below production threshold (70)");

  return {
    dimension: "Navigation", score, weight: 0.10,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scoreLayout(
  fid?: VisualFidelityReport,
  pct?: PerceptualScore,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 72;
  let confidence = 0.3;

  const layFid  = fid?.summary.metrics.layout;
  const layPct  = pct?.scores.layout;
  const secPct  = pct?.scores.sections;

  if (layFid !== undefined) { sources.push("VR-7"); confidence += 0.35; }
  if (layPct !== undefined) { sources.push("PF-1"); confidence += 0.25; }

  if (layFid !== undefined && layPct !== undefined && secPct !== undefined) {
    score = clamp(layFid * 0.5 + layPct * 100 * 0.3 + secPct * 100 * 0.2);
  } else if (layFid !== undefined && layPct !== undefined) {
    score = clamp(layFid * 0.6 + layPct * 100 * 0.4);
  } else if (layFid !== undefined) {
    score = clamp(layFid);
  } else if (layPct !== undefined) {
    score = clamp(layPct * 100);
  }

  if (fid) {
    const drifts = fid.issues.layoutDrift?.length ?? 0;
    if (drifts > 3) { issues.push(`${drifts} layout drift issues detected`); score = clamp(score - drifts * 3); }
    const missing = fid.issues.missingSections?.length ?? 0;
    if (missing > 0) { issues.push(`${missing} missing section(s)`); score = clamp(score - missing * 5); }
  }

  if (score < 70) issues.push("Layout fidelity below production threshold (70)");

  return {
    dimension: "Layout", score, weight: 0.15,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scoreTypography(
  typo?: TypographyFidelityReport,
  pct?: PerceptualScore,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 70;
  let confidence = 0.3;

  const typoScore = typo?.summary.overallScore;
  const typoPct   = pct?.scores.typography;

  if (typoScore !== undefined) { sources.push("B6"); confidence += 0.4; }
  if (typoPct   !== undefined) { sources.push("PF-1"); confidence += 0.2; }

  if (typoScore !== undefined && typoPct !== undefined) {
    score = clamp(typoScore * 0.7 + typoPct * 100 * 0.3);
  } else if (typoScore !== undefined) {
    score = clamp(typoScore);
  } else if (typoPct !== undefined) {
    score = clamp(typoPct * 100);
  }

  // B6-specific issues
  if (typo) {
    const highIssues = typo.issues.filter(i => i.severity === "high");
    if (highIssues.length > 0) {
      issues.push(`${highIssues.length} high-severity typography issue(s): ${highIssues[0]?.description ?? ""}`);
      score = clamp(score - highIssues.length * 6);
    }
    const m = typo.summary.metrics;
    if (m.fontFamily < 50) issues.push(`Font family mismatch (score: ${m.fontFamily})`);
    if (m.headingHierarchy < 60) issues.push(`Heading hierarchy drift (score: ${m.headingHierarchy})`);
  }

  if (score < 70) issues.push("Typography fidelity below production threshold (70)");

  return {
    dimension: "Typography", score, weight: 0.12,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scoreSpacing(
  fid?: VisualFidelityReport,
  typo?: TypographyFidelityReport,
  pct?: PerceptualScore,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 70;
  let confidence = 0.3;

  const spacFid    = fid?.summary.metrics.spacing;
  // B6 doesn't have a single "spacing" field; derive from padding + margins average
  const spacTypo   = typo
    ? Math.round((typo.summary.metrics.padding + typo.summary.metrics.margins) / 2)
    : undefined;
  const spacWs     = pct?.scores.whitespace;

  if (spacFid   !== undefined) { sources.push("VR-7"); confidence += 0.3; }
  if (spacTypo  !== undefined) { sources.push("B6");   confidence += 0.3; }
  if (spacWs    !== undefined) { sources.push("PF-1"); confidence += 0.1; }

  const vals = [
    spacFid  !== undefined ? spacFid      : null,
    spacTypo !== undefined ? spacTypo     : null,
    spacWs   !== undefined ? spacWs * 100 : null,
  ].filter((v): v is number => v !== null);

  if (vals.length > 0) {
    score = clamp(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // Spacing heuristics from B6 individual metrics
  if (typo) {
    if (typo.summary.metrics.padding < 50)  { issues.push(`Padding scale differs (score: ${typo.summary.metrics.padding})`); }
    if (typo.summary.metrics.margins < 50)  { issues.push(`Margin scale differs (score: ${typo.summary.metrics.margins})`);  }
    if (typo.summary.metrics.verticalRhythm < 55) { issues.push("Vertical rhythm unit mismatch"); score = clamp(score - 5); }
  }

  if (score < 70) issues.push("Spacing fidelity below production threshold (70)");

  return {
    dimension: "Spacing", score, weight: 0.10,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scoreResponsive(
  fid?: VisualFidelityReport,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 70;
  let confidence = 0.3;

  const respFid = fid?.summary.metrics.responsive;
  if (respFid !== undefined) { sources.push("VR-7"); confidence += 0.5; score = clamp(respFid); }

  if (score < 60) issues.push("Responsive layout fidelity significantly below source");
  if (score < 70) issues.push("Responsive fidelity below production threshold (70)");

  return {
    dimension: "Responsive", score, weight: 0.10,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scoreComponent(
  fid?: VisualFidelityReport,
  comp?: ComponentErrorReport,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 72;
  let confidence = 0.3;

  const compFid = fid?.summary.metrics.component;
  if (compFid !== undefined) { sources.push("VR-7"); confidence += 0.3; }

  if (comp) {
    sources.push("PF-2");
    confidence += 0.35;
    // Penalize based on critical/high counts
    const criticalPenalty = comp.criticalCount * 8;
    const highPenalty     = comp.highCount * 4;
    const mediumPenalty   = comp.mediumCount * 1;
    const basePct = comp.totalComponents > 0
      ? ((comp.totalComponents - comp.criticalCount - comp.highCount - comp.mediumCount) / comp.totalComponents) * 100
      : 80;
    const compScore = clamp(basePct - criticalPenalty * 0.3 - highPenalty * 0.2 - mediumPenalty * 0.05);

    if (compFid !== undefined) {
      score = clamp(compFid * 0.5 + compScore * 0.5);
    } else {
      score = compScore;
    }

    if (comp.criticalCount > 0) issues.push(`${comp.criticalCount} critical component error(s)`);
    if (comp.highCount > 2)     issues.push(`${comp.highCount} high-severity component issues`);
    if (comp.topPriorityFixes.length > 0) issues.push(`Top fix: ${comp.topPriorityFixes[0]}`);
  } else if (compFid !== undefined) {
    score = clamp(compFid);
  }

  const mismatches = fid?.issues.componentMismatches?.length ?? 0;
  if (mismatches > 0) { issues.push(`${mismatches} component mismatch(es)`); score = clamp(score - mismatches * 2); }

  if (score < 70) issues.push("Component fidelity below production threshold (70)");

  return {
    dimension: "Component", score, weight: 0.15,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scoreImage(
  pct?: PerceptualScore,
  comp?: ComponentErrorReport,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 72;
  let confidence = 0.3;

  const imgPct = pct?.scores.images;
  if (imgPct !== undefined) { sources.push("PF-1"); confidence += 0.45; score = clamp(imgPct * 100); }

  // Image-related component errors
  if (comp) {
    sources.push("PF-2");
    const imgErrors = comp.components.filter(c =>
      c.componentType === "image_placement" || c.description?.toLowerCase().includes("image"),
    );
    if (imgErrors.length > 0) {
      issues.push(`${imgErrors.length} image component issue(s)`);
      score = clamp(score - imgErrors.length * 3);
    }
  }

  if (score < 60) issues.push("Image rendering quality significantly below source");
  if (score < 70) issues.push("Image fidelity below production threshold (70)");

  return {
    dimension: "Image", score, weight: 0.10,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scoreInteraction(
  cons?: ConsistencyReport,
  comp?: ComponentErrorReport,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 72;
  let confidence = 0.3;

  // Interaction is inferred from navigation + component consistency
  if (cons) {
    sources.push("VR-6");
    confidence += 0.25;
    // Use component + layout consistency as interaction proxy
    const interScore = clamp(
      cons.metrics.componentConsistency * 0.5 +
      cons.metrics.layoutConsistency * 0.3 +
      cons.metrics.themeConsistency * 0.2,
    );
    score = interScore;

    const navIssues = cons.issues.filter(i =>
      i.kind === "missing_global_nav" || i.kind === "nav_placement_mismatch",
    );
    if (navIssues.length > 0) {
      issues.push(`${navIssues.length} interactive navigation issue(s)`);
      score = clamp(score - navIssues.length * 4);
    }
  }

  if (comp) {
    sources.push("PF-2");
    confidence += 0.2;
    const interErrors = comp.components.filter(c =>
      c.componentType === "navigation" || c.description?.toLowerCase().includes("form") ||
      c.description?.toLowerCase().includes("button"),
    );
    if (interErrors.length > 0) {
      issues.push(`${interErrors.length} interactive element issue(s)`);
      score = clamp(score - interErrors.length * 3);
    }
  }

  if (!cons && !comp) {
    issues.push("No interaction data available — score estimated");
  }

  if (score < 70) issues.push("Interaction fidelity below production threshold (70)");

  return {
    dimension: "Interaction", score, weight: 0.08,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

function scorePixel(
  pixel?: PixelComparisonReport,
  pct?: PerceptualScore,
): DimensionScore {
  const sources: string[] = [];
  const issues: string[]  = [];
  let score = 70;
  let confidence = 0.3;

  const ssimScore  = pixel ? ssimToScore(pixel.overallSsim) : null;
  const pctOverall = pct?.scores.overall;

  if (ssimScore    !== null) { sources.push("PF-1"); confidence += 0.4; }
  if (pctOverall   !== undefined) { sources.push("PF-1"); confidence += 0.1; }

  if (ssimScore !== null && pctOverall !== undefined) {
    score = clamp(ssimScore * 0.7 + pctOverall * 100 * 0.3);
  } else if (ssimScore !== null) {
    score = ssimScore;
  } else if (pctOverall !== undefined) {
    score = clamp(pctOverall * 100);
  }

  if (pixel) {
    const mismatch = pixel.totalMismatchPct;
    if (mismatch > 30) { issues.push(`High pixel mismatch: ${mismatch.toFixed(1)}%`); }
    else if (mismatch > 15) { issues.push(`Notable pixel mismatch: ${mismatch.toFixed(1)}%`); }

    const worstRegion = [...pixel.regions].sort((a, b) => a.ssim - b.ssim)[0];
    if (worstRegion && worstRegion.ssim < 0.6) {
      issues.push(`Region "${worstRegion.region}" has low pixel similarity (SSIM=${worstRegion.ssim.toFixed(3)})`);
    }
  }

  if (score < 70) issues.push("Pixel fidelity below production threshold (70)");

  return {
    dimension: "Pixel", score, weight: 0.10,
    grade: certGrade(score), confidence: Math.min(1, confidence),
    sources: sources.length ? sources : ["fallback"],
    issues,
  };
}

// ---------------------------------------------------------------------------
// Deficiency builder
// ---------------------------------------------------------------------------

function buildDeficiencies(dims: DimensionScore[]): VisualDeficiency[] {
  const out: VisualDeficiency[] = [];

  for (const dim of dims) {
    const blocking = dim.score < 55;
    const major    = dim.score >= 55 && dim.score < 70;

    for (const issue of dim.issues) {
      out.push({
        dimension:   dim.dimension,
        severity:    blocking ? "blocking" : major ? "major" : "minor",
        description: issue,
        impact:      blocking
          ? `${dim.dimension} failures will be visible to all users and undermine brand perception`
          : major
          ? `${dim.dimension} differences may be noticed by design-aware users`
          : `${dim.dimension} differences are subtle and unlikely to affect user experience`,
        fix: `Re-run ${dim.dimension.toLowerCase()} alignment phase and apply generated RuleAdjustments`,
      });
    }
  }

  // Sort: blocking first, then major, then minor
  return out.sort((a, b) => {
    const sev = { blocking: 0, major: 1, minor: 2 };
    return sev[a.severity] - sev[b.severity];
  });
}

// ---------------------------------------------------------------------------
// Readiness report builder
// ---------------------------------------------------------------------------

function buildReadinessReport(
  cert: VisualCertificationReport,
): VisualReadinessReport {
  const checks: ReadinessCheck[] = [
    {
      name:        "Overall Reconstruction Score",
      status:      cert.overallScore >= 85 ? "pass" : cert.overallScore >= 70 ? "warn" : "fail",
      description: "Composite visual reconstruction score across all dimensions",
      detail:      `Score: ${cert.overallScore}/100 — Grade: ${cert.grade}`,
    },
    {
      name:        "Navigation Fidelity",
      status:      (cert.dimensions.find(d => d.dimension === "Navigation")?.score ?? 0) >= 70 ? "pass" : "fail",
      description: "Navigation structure matches source website",
      detail:      `Score: ${cert.dimensions.find(d => d.dimension === "Navigation")?.score ?? "N/A"}`,
    },
    {
      name:        "Layout Fidelity",
      status:      (cert.dimensions.find(d => d.dimension === "Layout")?.score ?? 0) >= 70 ? "pass" : "warn",
      description: "Page layout structure and section ordering match source",
      detail:      `Score: ${cert.dimensions.find(d => d.dimension === "Layout")?.score ?? "N/A"}`,
    },
    {
      name:        "Typography Fidelity",
      status:      (cert.dimensions.find(d => d.dimension === "Typography")?.score ?? 0) >= 70 ? "pass" : "warn",
      description: "Font families, weights, and typographic scale match source",
      detail:      `Score: ${cert.dimensions.find(d => d.dimension === "Typography")?.score ?? "N/A"}`,
    },
    {
      name:        "Component Fidelity",
      status:      (cert.dimensions.find(d => d.dimension === "Component")?.score ?? 0) >= 70 ? "pass" : "fail",
      description: "UI components are correctly identified and reconstructed",
      detail:      `Score: ${cert.dimensions.find(d => d.dimension === "Component")?.score ?? "N/A"}`,
    },
    {
      name:        "Pixel Accuracy",
      status:      (cert.dimensions.find(d => d.dimension === "Pixel")?.score ?? 0) >= 65 ? "pass" : "warn",
      description: "Pixel-level SSIM similarity between source and generated screenshots",
      detail:      `Score: ${cert.dimensions.find(d => d.dimension === "Pixel")?.score ?? "N/A"}`,
    },
    {
      name:        "Data Completeness",
      status:      cert.dataCompleteness.overallCompleteness >= 0.6 ? "pass" : "warn",
      description: "Sufficient fidelity data available for reliable certification",
      detail:      `Completeness: ${Math.round(cert.dataCompleteness.overallCompleteness * 100)}%`,
    },
  ];

  const blocking = cert.deficiencies.filter(d => d.severity === "blocking");
  const major    = cert.deficiencies.filter(d => d.severity === "major");
  const minor    = cert.deficiencies.filter(d => d.severity === "minor");

  const readinessStatus: ReadinessStatus =
    blocking.length > 0 ? "blocked"
    : major.length > 2  ? "conditional"
    : cert.overallScore < 70 ? "conditional"
    : "ready";

  // Next-step recommendations
  const nextSteps: string[] = [];
  if (cert.overallScore < 55) {
    nextSteps.push("Run Phase B7 Visual Optimization Loop to address critical deficiencies");
  }
  if (blocking.length > 0) {
    nextSteps.push(`Fix ${blocking.length} blocking deficiency(ies) before production deployment`);
  }
  for (const dim of cert.dimensions.filter(d => d.score < 60)) {
    nextSteps.push(`Improve ${dim.dimension} fidelity (current score: ${dim.score}) via targeted rule adjustments`);
  }
  if (nextSteps.length === 0) {
    nextSteps.push("Certification passed — review minor issues and proceed to production deployment");
  }

  // Estimated fix time based on blocking/major count
  const totalWork = blocking.length * 4 + major.length * 1.5 + minor.length * 0.25;
  const estimatedFixTime = totalWork === 0 ? "None required"
    : totalWork < 2 ? "< 1 hour (minor adjustments)"
    : totalWork < 8 ? `${Math.round(totalWork)} hours (focused remediation)`
    : `${Math.round(totalWork / 8)} day(s) (significant rework needed)`;

  return {
    schemaVersion:   "B8-1",
    sourceJobId:     cert.sourceJobId,
    generatedJobId:  cert.generatedJobId,
    certifiedAt:     cert.certifiedAt,
    readinessStatus,
    overallScore:    cert.overallScore,
    grade:           cert.grade,
    checks,
    blockingIssues:  blocking,
    majorIssues:     major,
    minorIssues:     minor,
    nextSteps,
    estimatedFixTime,
  };
}

// ---------------------------------------------------------------------------
// R2 / disk helpers
// ---------------------------------------------------------------------------

const OUT_DIR = process.cwd();

async function writeDisk(filename: string, data: unknown): Promise<void> {
  await writeFile(join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

async function uploadR2(key: string, data: Buffer): Promise<boolean> {
  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return false;
  try {
    await cloud.upload({ key, data, contentType: "application/json" });
    return true;
  } catch (err) {
    logger.warn({ err, key }, "B8: R2 upload failed (non-fatal)");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runVisualCertification(
  input: CertificationInput,
): Promise<{ report: VisualCertificationReport; grade: VisualGrade; readiness: VisualReadinessReport }> {
  const {
    sourceJobId, generatedJobId,
    fidelityReport, pixelReport, perceptualScore,
    componentReport, consistencyReport, typographyReport,
  } = input;

  const t0 = Date.now();
  logger.info({ sourceJobId, generatedJobId }, "B8: starting visual reconstruction certification");

  // ── Score all 9 dimensions ─────────────────────────────────────────────
  const dims: DimensionScore[] = [
    scoreNavigation(fidelityReport, consistencyReport),
    scoreLayout(fidelityReport, perceptualScore),
    scoreTypography(typographyReport, perceptualScore),
    scoreSpacing(fidelityReport, typographyReport, perceptualScore),
    scoreResponsive(fidelityReport),
    scoreComponent(fidelityReport, componentReport),
    scoreImage(perceptualScore, componentReport),
    scoreInteraction(consistencyReport, componentReport),
    scorePixel(pixelReport, perceptualScore),
  ];

  // ── Weighted composite ─────────────────────────────────────────────────
  const overallScore = clamp(
    dims.reduce((sum, d) => sum + d.score * d.weight, 0),
  );
  const grade = certGrade(overallScore);

  // ── Data completeness ──────────────────────────────────────────────────
  const hasPixelComparison   = Boolean(pixelReport);
  const hasPerceptualScore   = Boolean(perceptualScore);
  const hasComponentReport   = Boolean(componentReport);
  const hasConsistencyReport = Boolean(consistencyReport);
  const hasTypographyReport  = Boolean(typographyReport);
  const hasFidelityReport    = Boolean(fidelityReport);
  const completeness = [
    hasPixelComparison, hasPerceptualScore, hasComponentReport,
    hasConsistencyReport, hasTypographyReport, hasFidelityReport,
  ].filter(Boolean).length / 6;

  // ── Build deficiencies ─────────────────────────────────────────────────
  const deficiencies = buildDeficiencies(dims);

  // ── Assemble main report ───────────────────────────────────────────────
  const now = new Date().toISOString();
  const report: VisualCertificationReport = {
    schemaVersion: "B8-1",
    sourceJobId, generatedJobId,
    certifiedAt:     now,
    durationMs:      Date.now() - t0,
    overallScore,
    grade,
    productionReady: grade === "A+" || grade === "A" || grade === "B",
    dimensions:      dims,
    deficiencies,
    dataCompleteness: {
      hasPixelComparison, hasPerceptualScore, hasComponentReport,
      hasConsistencyReport, hasTypographyReport, hasFidelityReport,
      overallCompleteness: Math.round(completeness * 100) / 100,
    },
    r2Keys: { report: null, grade: null, readiness: null },
  };

  // ── Grade summary ──────────────────────────────────────────────────────
  const certId = `cert-${sourceJobId.slice(0, 8)}-${generatedJobId.slice(0, 8)}-${Date.now()}`;
  const gradeDoc: VisualGrade = {
    schemaVersion: "B8-1",
    sourceJobId, generatedJobId,
    certifiedAt:     now,
    overallScore,
    grade,
    productionReady: report.productionReady,
    dimensionSummary: Object.fromEntries(dims.map(d => [d.dimension, { score: d.score, grade: d.grade }])),
    topDeficiencies:  deficiencies.slice(0, 5).map(d => d.description),
    certificationId:  certId,
  };

  // ── Readiness report ───────────────────────────────────────────────────
  const readiness = buildReadinessReport(report);

  // ── Persist ───────────────────────────────────────────────────────────
  const prefix = `jobs/${sourceJobId}/b8`;
  const keys   = {
    report:    `${prefix}/visual-certification-report.json`,
    grade:     `${prefix}/visual-grade.json`,
    readiness: `${prefix}/visual-readiness-report.json`,
  };

  await Promise.all([
    writeDisk("visual-certification-report.json", report),
    writeDisk("visual-grade.json", gradeDoc),
    writeDisk("visual-readiness-report.json", readiness),
    uploadR2(keys.report,    Buffer.from(JSON.stringify(report,    null, 2))).then(ok => { if (ok) report.r2Keys.report    = keys.report;    }),
    uploadR2(keys.grade,     Buffer.from(JSON.stringify(gradeDoc,  null, 2))).then(ok => { if (ok) report.r2Keys.grade     = keys.grade;     }),
    uploadR2(keys.readiness, Buffer.from(JSON.stringify(readiness, null, 2))).then(ok => { if (ok) report.r2Keys.readiness = keys.readiness; }),
  ]);

  _store.set(storeKey(sourceJobId, generatedJobId), { report, grade: gradeDoc, readiness });

  logger.info(
    {
      sourceJobId, generatedJobId,
      overallScore, grade,
      productionReady: report.productionReady,
      blocking: deficiencies.filter(d => d.severity === "blocking").length,
      durationMs: report.durationMs,
    },
    "B8: visual certification complete",
  );

  return { report, grade: gradeDoc, readiness };
}
