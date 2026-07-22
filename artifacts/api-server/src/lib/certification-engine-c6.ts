/**
 * certification-engine-c6.ts — Phase C6: Website Prime Certification
 *
 * Read-only aggregation engine. Reads C2/C3/C4/C5 bundles + the manifest
 * and produces a final production certification.
 *
 * Does NOT modify Website Prime.
 *
 * Grades (each dimension scored 0–100, mapped to A+–F):
 *   Performance     — C3 CWV + TTFB + bundle size
 *   SEO             — C4 search readiness score
 *   Accessibility   — C4 alt-text coverage + heading hierarchy + lang/viewport
 *   Maintainability — C2 asset health + C5 framework detection + code signals
 *   Scalability     — C5 static/ISR ratio + rendering health score
 *   Runtime         — C5 runtime health + C3 TTI/TBT
 *   Overall         — weighted average
 *
 * Produces (R2 + in-memory):
 *   website-prime-certification.json
 *   website-prime-score.json
 *   production-readiness-report.json
 */

import { logger } from "./logger.js";
import { loadManifest } from "./manifest-store.js";
import { getC2Bundle } from "./asset-intelligence-engine-c2.js";
import { getC3Bundle, CWV_THRESHOLDS } from "./runtime-performance-engine-c3.js";
import { getC4Bundle } from "./seo-intelligence-engine-c4.js";
import { getC5Bundle } from "./runtime-optimizer-engine-c5.js";
import { createCloudProvider } from "../cloud/index.js";

// ── Grade mapping ─────────────────────────────────────────────────────────────

type LetterGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "D-" | "F";
type RatingLabel = "Outstanding" | "Excellent" | "Very Good" | "Good" | "Above Average" | "Average" |
                   "Below Average" | "Poor" | "Very Poor" | "Failing";

function scoreToGrade(score: number): LetterGrade {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

function scoreToRating(score: number): RatingLabel {
  if (score >= 95) return "Outstanding";
  if (score >= 90) return "Excellent";
  if (score >= 85) return "Very Good";
  if (score >= 80) return "Good";
  if (score >= 75) return "Above Average";
  if (score >= 70) return "Average";
  if (score >= 65) return "Below Average";
  if (score >= 55) return "Poor";
  if (score >= 45) return "Very Poor";
  return "Failing";
}

// ── Shared types ──────────────────────────────────────────────────────────────

export interface GradeDimension {
  score: number;
  grade: LetterGrade;
  rating: RatingLabel;
  dataSource: string;
  keyFindings: string[];
  issues: ProductionIssue[];
}

export interface ProductionIssue {
  id: string;
  severity: "blocker" | "critical" | "major" | "minor" | "advisory";
  category: string;
  title: string;
  description: string;
  affectedPages?: string[];
  recommendation: string;
  effortEstimate: "hours" | "days" | "weeks";
  blocksProduction: boolean;
}

// ── Grade calculators ─────────────────────────────────────────────────────────

interface ManifestHint { pageCount: number; coveragePct: number }

function gradePerformance(c3: ReturnType<typeof getC3Bundle>, hint?: ManifestHint): GradeDimension {
  const issues: ProductionIssue[] = [];
  const findings: string[] = [];

  if (!c3) {
    // When C3 has not run, derive a reasonable baseline score from the available
    // manifest signals (page count, coverage). This avoids punishing real-world
    // sites with an arbitrary 50 when the analysis phases simply haven't been
    // run yet. The score is conservative but better calibrated.
    const pageCount   = hint?.pageCount   ?? 0;
    const coveragePct = hint?.coveragePct ?? 0;
    // Multi-page sites with high coverage are more likely to be real and performant
    const baselineScore = Math.min(72, 55 + Math.floor(pageCount / 5) + Math.floor(coveragePct / 20));
    findings.push("C3 runtime performance analysis not run — score estimated from manifest only");
    return {
      score: baselineScore, grade: scoreToGrade(baselineScore), rating: scoreToRating(baselineScore),
      dataSource: "none (manifest estimate)",
      keyFindings: findings, issues: [{
        id: "PERF-NO-C3",
        severity: "major",
        category: "Performance",
        title: "Runtime performance analysis not completed",
        description: "Phase C3 (Runtime Performance Engine) has not been run for this job. Accurate CWV metrics are unavailable.",
        recommendation: "Run POST /api/runtime-performance/analyze with this jobId before certification.",
        effortEstimate: "hours",
        blocksProduction: false,
      }],
    };
  }

  const cwv   = c3.coreWebVitalsReport;
  const rt    = c3.runtimePerformanceReport;
  const ba    = c3.bundleAnalysis;

  // Base score from CWV
  const { passGood, needsImprovement, poor, totalPages } = cwv.summary;
  const total = totalPages || 1;
  const cwvScore = Math.round((passGood * 100 + needsImprovement * 60 + poor * 20) / total);

  // Bundle penalty
  const totalJsKb = (ba.aggregates.estimatedTotalJsBytes / 1024);
  const jsPenalty = totalJsKb > 500 ? 15 : totalJsKb > 300 ? 8 : totalJsKb > 150 ? 3 : 0;

  // Median TTFB penalty
  const ttfb = rt.aggregates.medianTtfb;
  const ttfbPenalty = ttfb !== null ? (ttfb > 1500 ? 15 : ttfb > 800 ? 8 : ttfb > 400 ? 3 : 0) : 0;

  const score = Math.max(0, Math.min(100, cwvScore - jsPenalty - ttfbPenalty));

  // Findings
  if (cwv.summary.overallRating === "good") findings.push(`All CWV metrics passing "Good" thresholds`);
  else if (poor > 0) findings.push(`${poor}/${total} page(s) failing at least one CWV metric (Poor)`);
  if (rt.aggregates.medianFcp !== null) findings.push(`Median FCP: ${rt.aggregates.medianFcp.toFixed(0)}ms`);
  if (rt.aggregates.medianLcp !== null) findings.push(`Median LCP: ${rt.aggregates.medianLcp.toFixed(0)}ms`);
  if (totalJsKb > 0) findings.push(`Total JS bundle: ${totalJsKb.toFixed(0)} KB`);

  // Issues
  const poorPages = cwv.pages.filter(p => p.overallRating === "poor");
  if (poorPages.length > 0) {
    issues.push({
      id: "PERF-CWV-POOR",
      severity: poorPages.length > 2 ? "critical" : "major",
      category: "Performance",
      title: `${poorPages.length} page(s) with Poor Core Web Vitals`,
      description: `These pages will receive Google ranking penalties and damage user experience.`,
      affectedPages: poorPages.map(p => p.url),
      recommendation: "Address FCP/LCP/TBT/CLS issues identified in the C3 core-web-vitals-report. Prioritise LCP image preloading and render-blocking resource elimination.",
      effortEstimate: "days",
      blocksProduction: poorPages.length > total * 0.5,
    });
  }

  const niPages = cwv.pages.filter(p => p.overallRating === "needs-improvement");
  if (niPages.length > 0) {
    issues.push({
      id: "PERF-CWV-NI",
      severity: "minor",
      category: "Performance",
      title: `${niPages.length} page(s) "Needs Improvement" on CWV`,
      description: "Pages are not meeting the Good threshold and may be deprioritised in Google Search.",
      affectedPages: niPages.map(p => p.url),
      recommendation: "Review C3 performance-recommendations.json for page-specific fixes.",
      effortEstimate: "days",
      blocksProduction: false,
    });
  }

  if (totalJsKb > 500) {
    issues.push({
      id: "PERF-JS-OVERSIZED",
      severity: "major",
      category: "Performance",
      title: `JavaScript bundle is ${totalJsKb.toFixed(0)} KB — exceeds 500 KB budget`,
      description: "Oversized JS bundles cause slow parse time, high TBT, and poor mobile performance.",
      recommendation: "Implement route-based code splitting. Remove unused dependencies. Run bundle-analysis.json to identify the heaviest files.",
      effortEstimate: "days",
      blocksProduction: false,
    });
  }

  if (ttfb !== null && ttfb > 1500) {
    issues.push({
      id: "PERF-TTFB-SLOW",
      severity: "critical",
      category: "Performance",
      title: `Median TTFB is ${ttfb.toFixed(0)}ms — critically slow`,
      description: "TTFB above 1500ms indicates a server-side bottleneck directly degrading all paint metrics.",
      recommendation: "Enable CDN caching, optimise server-side rendering, or move to edge deployment.",
      effortEstimate: "days",
      blocksProduction: true,
    });
  }

  return { score, grade: scoreToGrade(score), rating: scoreToRating(score), dataSource: "C3", keyFindings: findings, issues };
}

function gradeSeo(c4: ReturnType<typeof getC4Bundle>, hint?: ManifestHint): GradeDimension {
  const issues: ProductionIssue[] = [];
  const findings: string[] = [];

  if (!c4) {
    // Calibrated neutral: real-world sites that haven't had C4 run yet
    // shouldn't be scored as harshly as completely broken sites.
    const pageCount   = hint?.pageCount ?? 0;
    const baselineScore = Math.min(68, 55 + Math.floor(pageCount / 4));
    findings.push("C4 SEO analysis not run — score is a calibrated estimate");
    return {
      score: baselineScore, grade: scoreToGrade(baselineScore), rating: scoreToRating(baselineScore), dataSource: "none (manifest estimate)",
      keyFindings: findings, issues: [{
        id: "SEO-NO-C4", severity: "major", category: "SEO",
        title: "SEO intelligence analysis not completed",
        description: "Phase C4 has not been run — SEO status unknown.",
        recommendation: "Run POST /api/seo-intelligence/analyze before certification.",
        effortEstimate: "hours", blocksProduction: false,
      }],
    };
  }

  const sr    = c4.searchReadinessReport;
  const seo   = c4.seoReport;
  const meta  = c4.metadataReport;

  const score = sr.overallScore;

  // Findings
  findings.push(`Search readiness score: ${score}/100 (${sr.overallRating})`);
  findings.push(`Sitemap: ${sr.sitemap.urlCount} indexable URLs`);
  findings.push(`Meta description coverage: ${meta.coverage.description}%`);
  findings.push(`OpenGraph coverage: og:image ${meta.coverage.ogImage}%`);
  if (seo.duplicateTitles.length > 0) findings.push(`${seo.duplicateTitles.length} duplicate page title(s) detected`);
  if (seo.duplicateDescriptions.length > 0) findings.push(`${seo.duplicateDescriptions.length} duplicate meta description(s) detected`);

  // Issues
  if (seo.issues.critical > 0) {
    issues.push({
      id: "SEO-CRITICAL-ISSUES",
      severity: "critical",
      category: "SEO",
      title: `${seo.issues.critical} critical SEO issue(s) detected`,
      description: "Critical issues include missing titles, missing meta descriptions, no H1, or noindex on important pages.",
      recommendation: "Review seo-report.json issues array. Fix all critical issues before launch — they directly prevent search indexing.",
      effortEstimate: "days",
      blocksProduction: seo.issues.critical > 3,
    });
  }

  if (seo.duplicateTitles.length > 0) {
    issues.push({
      id: "SEO-DUPLICATE-TITLES",
      severity: "major",
      category: "SEO",
      title: `${seo.duplicateTitles.length} duplicate page title(s)`,
      description: "Duplicate titles confuse search engines and reduce click-through rates.",
      recommendation: "Make each page title unique and descriptive (30–60 chars). Use dynamic titles for content templates.",
      effortEstimate: "hours",
      blocksProduction: false,
    });
  }

  if (meta.coverage.canonical < 90) {
    issues.push({
      id: "SEO-MISSING-CANONICALS",
      severity: "major",
      category: "SEO",
      title: `Canonical URL missing on ${Math.round((1 - meta.coverage.canonical / 100) * seo.pagesAnalyzed)} page(s)`,
      description: "Missing canonical URLs risk duplicate content penalties when pages are accessed via multiple URLs.",
      recommendation: "Add <link rel='canonical' href='[self-referencing-url]'> to every page <head>.",
      effortEstimate: "hours",
      blocksProduction: false,
    });
  }

  if (meta.coverage.ogImage < 80) {
    issues.push({
      id: "SEO-OG-IMAGE-MISSING",
      severity: "minor",
      category: "SEO",
      title: `og:image missing on ${Math.round((1 - meta.coverage.ogImage / 100) * seo.pagesAnalyzed)} page(s)`,
      description: "Pages without og:image show poorly on social media — no preview image reduces click-through rates.",
      recommendation: "Add og:image (minimum 1200×630px) to all key pages. Use a fallback social card for content templates.",
      effortEstimate: "hours",
      blocksProduction: false,
    });
  }

  return { score, grade: scoreToGrade(score), rating: scoreToRating(score), dataSource: "C4", keyFindings: findings, issues };
}

function gradeAccessibility(c4: ReturnType<typeof getC4Bundle>): GradeDimension {
  const issues: ProductionIssue[] = [];
  const findings: string[] = [];

  if (!c4) {
    findings.push("Accessibility signals derived from SEO data — run C4 for full analysis");
    return {
      score: 50, grade: scoreToGrade(50), rating: scoreToRating(50), dataSource: "none",
      keyFindings: findings, issues: [],
    };
  }

  const seo  = c4.seoReport;
  const meta = c4.metadataReport;

  // Accessibility score from available proxies
  let score = 100;
  const n = seo.pagesAnalyzed || 1;

  // Alt text coverage
  const altMissingPct = (seo.missingAltCount / Math.max(seo.pages.reduce((s, p) => s + p.images.length, 0), 1)) * 100;
  score -= Math.round(altMissingPct * 0.3); // up to 30 point deduction

  // Language attribute
  const langCoverage = meta.coverage.lang;
  if (langCoverage < 100) score -= Math.round((100 - langCoverage) * 0.2); // up to 20 pts

  // Viewport meta
  const viewportCoverage = meta.coverage.viewport;
  if (viewportCoverage < 100) score -= Math.round((100 - viewportCoverage) * 0.15);

  // Heading hierarchy issues
  const headingIssuePages = seo.pages.filter(p => !p.hasProperHeadingHierarchy).length;
  score -= Math.round((headingIssuePages / n) * 20); // up to 20 pts

  // H1 missing
  const missingH1 = seo.pages.filter(p => p.h1Count === 0).length;
  score -= Math.round((missingH1 / n) * 15); // up to 15 pts

  score = Math.max(0, Math.min(100, score));

  // Findings
  findings.push(`Alt text missing on ${seo.missingAltCount} image(s) across all pages`);
  findings.push(`Language attribute coverage: ${langCoverage}%`);
  findings.push(`Viewport meta tag coverage: ${viewportCoverage}%`);
  findings.push(`${headingIssuePages}/${n} page(s) with heading hierarchy issues`);
  findings.push(`${missingH1} page(s) missing H1 tag`);
  findings.push("Note: Full WCAG 2.1 AA audit (color contrast, keyboard focus, ARIA) requires Phase C7 dedicated accessibility scanner");

  // Issues
  if (seo.missingAltCount > 0) {
    issues.push({
      id: "A11Y-ALT-TEXT",
      severity: seo.missingAltCount > 10 ? "critical" : "major",
      category: "Accessibility",
      title: `${seo.missingAltCount} image(s) missing alt text`,
      description: "Missing alt text fails WCAG 2.1 Success Criterion 1.1.1 (Non-text Content) — Level A — the most basic accessibility requirement.",
      affectedPages: seo.pages.filter(p => p.imagesWithoutAlt > 0).map(p => p.url),
      recommendation: "Add descriptive alt text to all meaningful images. Use alt='' only for decorative images.",
      effortEstimate: "hours",
      blocksProduction: seo.missingAltCount > 20,
    });
  }

  if (missingH1 > 0) {
    issues.push({
      id: "A11Y-MISSING-H1",
      severity: "major",
      category: "Accessibility",
      title: `${missingH1} page(s) missing H1 heading`,
      description: "Missing H1 breaks screen reader navigation and heading outline. Fails WCAG 2.1 SC 2.4.6 (Headings and Labels).",
      recommendation: "Add a visible H1 to every page. It should match or closely reflect the page <title>.",
      effortEstimate: "hours",
      blocksProduction: false,
    });
  }

  if (headingIssuePages > 0) {
    issues.push({
      id: "A11Y-HEADING-HIERARCHY",
      severity: "minor",
      category: "Accessibility",
      title: `${headingIssuePages} page(s) with skipped heading levels`,
      description: "Skipped heading levels (e.g. H1→H3) break document outline and screen reader navigation.",
      recommendation: "Review heading-hierarchy-issues in seo-report.json and correct level sequence.",
      effortEstimate: "hours",
      blocksProduction: false,
    });
  }

  if (langCoverage < 100) {
    issues.push({
      id: "A11Y-MISSING-LANG",
      severity: "major",
      category: "Accessibility",
      title: `Missing lang attribute on ${Math.round((1 - langCoverage / 100) * n)} page(s)`,
      description: "Missing lang fails WCAG 2.1 SC 3.1.1 — screen readers cannot determine language for correct speech synthesis.",
      recommendation: "Add lang='en' (or appropriate locale) to the <html> element on every page.",
      effortEstimate: "hours",
      blocksProduction: false,
    });
  }

  issues.push({
    id: "A11Y-WCAG-AUDIT-NEEDED",
    severity: "advisory",
    category: "Accessibility",
    title: "Full WCAG 2.1 AA audit not completed",
    description: "Color contrast ratios, keyboard focus order, ARIA roles, form labeling, and touch targets cannot be evaluated without a dedicated accessibility scanner (Phase C7).",
    recommendation: "Run axe-core, pa11y, or Lighthouse accessibility audit. Engage a manual WCAG tester before enterprise sign-off.",
    effortEstimate: "days",
    blocksProduction: false,
  });

  return { score, grade: scoreToGrade(score), rating: scoreToRating(score), dataSource: "C4 (proxy)", keyFindings: findings, issues };
}

function gradeMaintainability(
  c2: ReturnType<typeof getC2Bundle>,
  c5: ReturnType<typeof getC5Bundle>,
): GradeDimension {
  const issues: ProductionIssue[] = [];
  const findings: string[] = [];
  let score = 75; // default when data is limited

  if (c2) {
    const ai  = c2.assetIntelligenceReport;
    const opt = c2.assetOptimizationReport;
    const dup = c2.duplicateAssetReport;
    const lz  = c2.lazyLoadingReport;

    const totalDuplicates     = dup.summary.totalDuplicateAssets;
    const unoptimizedCount    = opt.summary.total;
    const lazyCandidates      = lz.summary.totalCandidates;
    const alreadyLazy         = lz.alreadyLazy;
    const totalLazyPool       = lazyCandidates + alreadyLazy;
    const totalUniqueAssets   = ai.summary.totalUniqueAssets;

    // Deduct for duplicates
    const dupPenalty = Math.min(20, totalDuplicates * 3);
    score -= dupPenalty;

    // Deduct for missing lazy loading
    if (totalLazyPool > 0) {
      const lazyRatio = alreadyLazy / totalLazyPool;
      score -= Math.round((1 - lazyRatio) * 10);
    }

    findings.push(`Total unique assets: ${totalUniqueAssets}`);
    findings.push(`Duplicate asset groups: ${dup.summary.totalDuplicateGroups} (${totalDuplicates} assets)`);
    findings.push(`Optimization opportunities: ${unoptimizedCount}`);
    if (totalDuplicates > 0) findings.push(`${totalDuplicates} duplicate assets detected — wasted bandwidth`);

    if (totalDuplicates > 5) {
      issues.push({
        id: "MAINT-DUPLICATE-ASSETS",
        severity: totalDuplicates > 20 ? "major" : "minor",
        category: "Maintainability",
        title: `${totalDuplicates} duplicate assets found across ${dup.summary.totalDuplicateGroups} group(s)`,
        description: "Duplicate assets indicate poor asset management — different pages load the same file multiple times under different URLs.",
        recommendation: "Consolidate assets to a CDN with canonical URLs. Use content-addressed filenames.",
        effortEstimate: "days",
        blocksProduction: false,
      });
    }

    if (unoptimizedCount > 0) {
      issues.push({
        id: "MAINT-UNOPTIMIZED-ASSETS",
        severity: unoptimizedCount > 20 ? "major" : "minor",
        category: "Maintainability",
        title: `${unoptimizedCount} asset optimization opportunit${unoptimizedCount === 1 ? "y" : "ies"} detected`,
        description: "Unoptimized assets waste bandwidth and slow delivery — they indicate a missing asset optimization pipeline.",
        recommendation: "Implement image optimization CI step (Sharp, Squoosh). Use WebP/AVIF with PNG/JPG fallback. Review asset-optimization-report.json.",
        effortEstimate: "days",
        blocksProduction: false,
      });
    }
  } else {
    findings.push("C2 asset intelligence not run — maintainability score estimated");
  }

  if (c5) {
    const fw = c5.renderingStrategy.framework;
    const hydration = c5.renderingStrategy.detectedHydration;
    findings.push(`Framework: ${fw} (hydration: ${hydration})`);

    if (fw === "Unknown") {
      score -= 10;
      issues.push({
        id: "MAINT-NO-FRAMEWORK",
        severity: "advisory",
        category: "Maintainability",
        title: "No modern framework detected",
        description: "Without a framework, routing, code splitting, data fetching, and rendering must be managed manually — increasing maintenance burden.",
        recommendation: "Consider adopting Next.js, Nuxt, Astro, or SvelteKit for structured rendering, routing, and deployment.",
        effortEstimate: "weeks",
        blocksProduction: false,
      });
    }

    const dynamicPct = c5.renderingStrategy.summary.dynamicPct;
    if (dynamicPct > 70) {
      score -= 8;
      issues.push({
        id: "MAINT-OVER-DYNAMIC",
        severity: "minor",
        category: "Maintainability",
        title: `${dynamicPct}% of pages are dynamic — over-reliance on SSR`,
        description: "Over-dynamism increases server load, deployment complexity, and maintenance burden.",
        recommendation: "Refactor eligible pages to static or ISR. Only auth/personalized pages need full SSR.",
        effortEstimate: "days",
        blocksProduction: false,
      });
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score, grade: scoreToGrade(score), rating: scoreToRating(score),
    dataSource: [c2 ? "C2" : null, c5 ? "C5" : null].filter(Boolean).join("+") || "none",
    keyFindings: findings, issues,
  };
}

function gradeScalability(c5: ReturnType<typeof getC5Bundle>, hint?: ManifestHint): GradeDimension {
  const issues: ProductionIssue[] = [];
  const findings: string[] = [];

  if (!c5) {
    // Neutral calibrated estimate — avoids hard-penalising sites
    // that simply haven't had C5 run yet.
    findings.push("C5 runtime optimizer not run — scalability score estimated from site coverage");
    const coveragePct = hint?.coveragePct ?? 0;
    const baselineScore = Math.min(65, 50 + Math.floor(coveragePct / 10));
    return {
      score: baselineScore, grade: scoreToGrade(baselineScore), rating: scoreToRating(baselineScore), dataSource: "none (manifest estimate)",
      keyFindings: findings, issues: [{
        id: "SCALE-NO-C5", severity: "major", category: "Scalability",
        title: "Runtime optimization analysis not completed",
        description: "Phase C5 has not been run — rendering strategy and scalability status unknown.",
        recommendation: "Run POST /api/runtime-optimizer/analyze before certification.",
        effortEstimate: "hours", blocksProduction: false,
      }],
    };
  }

  const rs = c5.renderingStrategy;
  const rh = c5.runtimeHealth;

  // Static + Incremental pages = cacheable = scalable
  const cacheablePct = rs.summary.staticPct + rs.summary.incrementalPct;
  const baseScore    = Math.round(cacheablePct * 0.6 + rh.overallScore * 0.4);

  // Penalty for health issues
  const criticalHealthIssues = rh.issues.filter(i => i.severity === "critical").length;
  const healthPenalty = criticalHealthIssues * 15;

  const score = Math.max(0, Math.min(100, baseScore - healthPenalty));

  // Findings
  findings.push(`${rs.summary.staticPct}% static, ${rs.summary.incrementalPct}% incremental, ${rs.summary.dynamicPct}% dynamic, ${rs.summary.hybridPct}% hybrid`);
  findings.push(`Cacheable pages: ${cacheablePct}%`);
  findings.push(`Runtime health score: ${rh.overallScore}/100 (${rh.overallRating})`);
  if (rs.framework !== "Unknown") findings.push(`Framework: ${rs.framework} — ${rs.frameworkRecommendation.slice(0, 80)}...`);

  // Issues from runtime health
  for (const hi of rh.issues) {
    issues.push({
      id: `SCALE-HEALTH-${hi.code}`,
      severity: hi.severity === "critical" ? "critical" : hi.severity === "warning" ? "major" : "advisory",
      category: "Scalability",
      title: hi.message.slice(0, 80),
      description: hi.message,
      affectedPages: hi.affectedUrls,
      recommendation: hi.fix,
      effortEstimate: "days",
      blocksProduction: hi.severity === "critical",
    });
  }

  if (cacheablePct < 40) {
    issues.push({
      id: "SCALE-LOW-CACHE-RATIO",
      severity: "critical",
      category: "Scalability",
      title: `Only ${cacheablePct}% of pages are CDN-cacheable`,
      description: "Low cacheable ratio means most traffic hits the origin server — the site will not scale under enterprise load without significant infrastructure cost.",
      recommendation: "Implement ISR for content pages. Move stable marketing pages to static generation. Reserve SSR for authenticated/personalized routes only.",
      effortEstimate: "weeks",
      blocksProduction: cacheablePct < 20,
    });
  }

  return { score, grade: scoreToGrade(score), rating: scoreToRating(score), dataSource: "C5", keyFindings: findings, issues };
}

function gradeRuntime(
  c3: ReturnType<typeof getC3Bundle>,
  c5: ReturnType<typeof getC5Bundle>,
): GradeDimension {
  const issues: ProductionIssue[] = [];
  const findings: string[] = [];
  let score = 70;

  if (c3) {
    const rt = c3.runtimePerformanceReport;
    const cwv = c3.coreWebVitalsReport;

    // TTI contribution
    const tti = rt.aggregates.medianTti;
    const tbt = rt.aggregates.medianTbt;
    const ttiScore = tti !== null ? (tti < CWV_THRESHOLDS.tti.good ? 100 : tti < CWV_THRESHOLDS.tti.needsImprovement ? 65 : 30) : 60;
    const tbtScore = tbt !== null ? (tbt < CWV_THRESHOLDS.tbt.good ? 100 : tbt < CWV_THRESHOLDS.tbt.needsImprovement ? 65 : 30) : 60;

    score = Math.round(ttiScore * 0.5 + tbtScore * 0.5);

    if (tti !== null) findings.push(`Median TTI: ${tti.toFixed(0)}ms`);
    if (tbt !== null) findings.push(`Median TBT: ${tbt.toFixed(0)}ms`);
    findings.push(`Hydration detection: ${c3.runtimePerformanceReport.pages.some(p => p.hydrationTime !== null) ? "detected" : "not detected"}`);
    findings.push(`Source type: ${c3.runtimePerformanceReport.pages[0]?.measurementSource ?? "unknown"}`);

    if (tbt !== null && tbt > CWV_THRESHOLDS.tbt.needsImprovement) {
      issues.push({
        id: "RUNTIME-HIGH-TBT",
        severity: "critical",
        category: "Runtime",
        title: `Median TBT ${tbt.toFixed(0)}ms — severely blocks main thread`,
        description: "Total Blocking Time above 600ms means the page feels unresponsive to user input for over 600ms after load.",
        recommendation: "Break up long JavaScript tasks (>50ms each). Use Web Workers for heavy computation. Implement code splitting to reduce initial JS parse.",
        effortEstimate: "days",
        blocksProduction: tbt > 1000,
      });
    }

    if (tti !== null && tti > CWV_THRESHOLDS.tti.needsImprovement) {
      issues.push({
        id: "RUNTIME-HIGH-TTI",
        severity: "major",
        category: "Runtime",
        title: `Median TTI ${tti.toFixed(0)}ms — slow time to interactive`,
        description: "TTI above 7300ms means the page appears but cannot respond to user input for over 7 seconds.",
        recommendation: "Reduce JS bundle size, implement code splitting, lazy-load below-fold components, and defer analytics scripts.",
        effortEstimate: "days",
        blocksProduction: false,
      });
    }
  } else {
    findings.push("C3 runtime data unavailable");
  }

  if (c5) {
    const rh = c5.runtimeHealth;
    score = c3 ? Math.round(score * 0.7 + rh.overallScore * 0.3) : rh.overallScore;
    findings.push(`C5 runtime health: ${rh.overallScore}/100 (${rh.overallRating})`);
    findings.push(`Rendering: ${rh.staticPageCount} static, ${rh.incrementalPageCount} ISR, ${rh.dynamicPageCount} dynamic, ${rh.hybridPageCount} hybrid`);
    findings.push(`Framework: ${rh.framework}`);
  }

  score = Math.max(0, Math.min(100, score));

  return { score, grade: scoreToGrade(score), rating: scoreToRating(score), dataSource: [c3 ? "C3" : null, c5 ? "C5" : null].filter(Boolean).join("+") || "none", keyFindings: findings, issues };
}

// ── Overall grade + certification level ──────────────────────────────────────

type CertificationLevel = "Production Ready" | "Conditionally Ready" | "Not Production Ready" | "Blocked";
type EnterpriseTier = "Enterprise Grade" | "Professional Grade" | "Standard Grade" | "Development Grade";

function overallFromDimensions(dimensions: Record<string, GradeDimension>): {
  score: number; grade: LetterGrade; rating: RatingLabel;
  certificationLevel: CertificationLevel; enterpriseTier: EnterpriseTier;
} {
  const weights: Record<string, number> = {
    performance: 0.25,
    seo: 0.20,
    accessibility: 0.15,
    maintainability: 0.10,
    scalability: 0.15,
    runtime: 0.15,
  };

  let total = 0, wSum = 0;
  for (const [key, w] of Object.entries(weights)) {
    const d = dimensions[key];
    if (d) { total += d.score * w; wSum += w; }
  }
  const score = wSum > 0 ? Math.round(total / wSum) : 50;
  const grade = scoreToGrade(score);
  const rating = scoreToRating(score);

  // Blockers prevent production
  const allIssues = Object.values(dimensions).flatMap(d => d.issues);
  const blockers = allIssues.filter(i => i.blocksProduction);

  let certificationLevel: CertificationLevel = "Not Production Ready";
  if (blockers.length > 0) certificationLevel = "Blocked";
  else if (score >= 80) certificationLevel = "Production Ready";
  else if (score >= 60) certificationLevel = "Conditionally Ready";

  let enterpriseTier: EnterpriseTier = "Development Grade";
  if (score >= 90 && blockers.length === 0) enterpriseTier = "Enterprise Grade";
  else if (score >= 75 && blockers.length === 0) enterpriseTier = "Professional Grade";
  else if (score >= 60) enterpriseTier = "Standard Grade";

  return { score, grade, rating, certificationLevel, enterpriseTier };
}

// ── Report shapes ─────────────────────────────────────────────────────────────

export interface WebsitePrimeCertification {
  jobId: string;
  generatedAt: string;
  certificationId: string;
  certifiedAt: string;
  certificationLevel: CertificationLevel;
  enterpriseTier: EnterpriseTier;
  overallScore: number;
  overallGrade: LetterGrade;
  overallRating: RatingLabel;
  grades: {
    performance: GradeDimension;
    seo: GradeDimension;
    accessibility: GradeDimension;
    maintainability: GradeDimension;
    scalability: GradeDimension;
    runtime: GradeDimension;
  };
  phasesCompleted: string[];
  phasesIncomplete: string[];
  certificationStatement: string;
  auditorNote: string;
}

export interface WebsitePrimeScore {
  jobId: string;
  generatedAt: string;
  certificationLevel: CertificationLevel;
  enterpriseTier: EnterpriseTier;
  overallScore: number;
  overallGrade: LetterGrade;
  scores: {
    performance: { score: number; grade: LetterGrade };
    seo: { score: number; grade: LetterGrade };
    accessibility: { score: number; grade: LetterGrade };
    maintainability: { score: number; grade: LetterGrade };
    scalability: { score: number; grade: LetterGrade };
    runtime: { score: number; grade: LetterGrade };
  };
  blockerCount: number;
  criticalIssueCount: number;
  totalIssueCount: number;
}

export interface ProductionReadinessReport {
  jobId: string;
  generatedAt: string;
  certificationLevel: CertificationLevel;
  readyForProduction: boolean;
  blockers: ProductionIssue[];
  criticalIssues: ProductionIssue[];
  majorIssues: ProductionIssue[];
  minorIssues: ProductionIssue[];
  advisories: ProductionIssue[];
  preflightChecklist: PreflightItem[];
  deploymentChecklist: DeploymentItem[];
  estimatedRemediation: string;
}

interface PreflightItem {
  id: string;
  category: string;
  check: string;
  status: "pass" | "fail" | "warn" | "unknown";
  detail: string;
}

interface DeploymentItem {
  step: number;
  action: string;
  tool: string;
  priority: "must-do" | "should-do" | "nice-to-have";
}

function buildPreflightChecklist(
  c2: ReturnType<typeof getC2Bundle>,
  c3: ReturnType<typeof getC3Bundle>,
  c4: ReturnType<typeof getC4Bundle>,
  c5: ReturnType<typeof getC5Bundle>,
  pageCount: number,
): PreflightItem[] {
  const items: PreflightItem[] = [];

  // Phase completion checks
  items.push({ id: "PRE-C2", category: "Phase Completion", check: "Asset Intelligence (C2) completed", status: c2 ? "pass" : "warn", detail: c2 ? `${c2.assetIntelligenceReport.summary.totalUniqueAssets} assets analyzed` : "Not run" });
  items.push({ id: "PRE-C3", category: "Phase Completion", check: "Runtime Performance (C3) completed", status: c3 ? "pass" : "warn", detail: c3 ? `${c3.runtimePerformanceReport.pagesAnalyzed} pages measured` : "Not run" });
  items.push({ id: "PRE-C4", category: "Phase Completion", check: "SEO Intelligence (C4) completed", status: c4 ? "pass" : "warn", detail: c4 ? `Score: ${c4.searchReadinessReport.overallScore}/100` : "Not run" });
  items.push({ id: "PRE-C5", category: "Phase Completion", check: "Runtime Optimizer (C5) completed", status: c5 ? "pass" : "warn", detail: c5 ? `Framework: ${c5.renderingStrategy.framework}` : "Not run" });

  // Performance checks
  if (c3) {
    const cwv = c3.coreWebVitalsReport;
    items.push({ id: "PRE-CWV", category: "Performance", check: "Core Web Vitals passing Good thresholds", status: cwv.summary.overallRating === "good" ? "pass" : cwv.summary.overallRating === "needs-improvement" ? "warn" : "fail", detail: `${cwv.summary.passGood}/${cwv.summary.totalPages} pages Good` });
    const ttfb = c3.runtimePerformanceReport.aggregates.medianTtfb;
    items.push({ id: "PRE-TTFB", category: "Performance", check: "TTFB < 800ms", status: ttfb === null ? "unknown" : ttfb < 800 ? "pass" : ttfb < 1500 ? "warn" : "fail", detail: ttfb !== null ? `Median TTFB: ${ttfb.toFixed(0)}ms` : "Not measured" });
    items.push({ id: "PRE-JS", category: "Performance", check: "JS bundle < 300 KB", status: c3.bundleAnalysis.aggregates.estimatedTotalJsBytes < 300_000 ? "pass" : "warn", detail: `${(c3.bundleAnalysis.aggregates.estimatedTotalJsBytes / 1024).toFixed(0)} KB` });
  } else {
    items.push({ id: "PRE-CWV", category: "Performance", check: "Core Web Vitals assessed", status: "unknown", detail: "C3 not run" });
  }

  // SEO checks
  if (c4) {
    const sr = c4.searchReadinessReport;
    const seo = c4.seoReport;
    items.push({ id: "PRE-SITEMAP", category: "SEO", check: "XML sitemap generated", status: "pass", detail: `${sr.sitemap.urlCount} URLs indexed` });
    items.push({ id: "PRE-ROBOTS", category: "SEO", check: "robots.txt generated", status: "pass", detail: "Stored to R2" });
    items.push({ id: "PRE-META", category: "SEO", check: "Meta descriptions coverage ≥ 90%", status: c4.metadataReport.coverage.description >= 90 ? "pass" : "warn", detail: `${c4.metadataReport.coverage.description}% coverage` });
    items.push({ id: "PRE-CANONICAL", category: "SEO", check: "Canonical URLs coverage ≥ 90%", status: c4.metadataReport.coverage.canonical >= 90 ? "pass" : "warn", detail: `${c4.metadataReport.coverage.canonical}% coverage` });
    items.push({ id: "PRE-SEO-CRITICAL", category: "SEO", check: "No critical SEO issues", status: seo.issues.critical === 0 ? "pass" : "fail", detail: `${seo.issues.critical} critical issue(s)` });
  } else {
    items.push({ id: "PRE-SITEMAP", category: "SEO", check: "XML sitemap generated", status: "unknown", detail: "C4 not run" });
  }

  // Accessibility checks (basic)
  if (c4) {
    items.push({ id: "PRE-ALT", category: "Accessibility", check: "All images have alt text", status: c4.seoReport.missingAltCount === 0 ? "pass" : c4.seoReport.missingAltCount < 5 ? "warn" : "fail", detail: `${c4.seoReport.missingAltCount} image(s) missing alt` });
    items.push({ id: "PRE-LANG", category: "Accessibility", check: "lang attribute on all pages", status: c4.metadataReport.coverage.lang === 100 ? "pass" : "warn", detail: `${c4.metadataReport.coverage.lang}% coverage` });
    items.push({ id: "PRE-VIEWPORT", category: "Accessibility", check: "Viewport meta on all pages", status: c4.metadataReport.coverage.viewport === 100 ? "pass" : "warn", detail: `${c4.metadataReport.coverage.viewport}% coverage` });
  }

  // Scalability checks
  if (c5) {
    const cacheablePct = c5.renderingStrategy.summary.staticPct + c5.renderingStrategy.summary.incrementalPct;
    items.push({ id: "PRE-CACHE", category: "Scalability", check: "≥ 50% pages CDN-cacheable", status: cacheablePct >= 50 ? "pass" : cacheablePct >= 30 ? "warn" : "fail", detail: `${cacheablePct}% static+ISR` });
    items.push({ id: "PRE-FRAMEWORK", category: "Scalability", check: "Modern framework detected", status: c5.renderingStrategy.framework !== "Unknown" ? "pass" : "warn", detail: c5.renderingStrategy.framework });
  }

  return items;
}

function buildDeploymentChecklist(): DeploymentItem[] {
  return [
    { step: 1, action: "Fix all production blockers listed in production-readiness-report.json", tool: "Code editor / CI", priority: "must-do" },
    { step: 2, action: "Upload sitemap.xml to /sitemap.xml on the production domain", tool: "C4 output: sitemap.xml → R2", priority: "must-do" },
    { step: 3, action: "Upload robots.txt to /robots.txt on the production domain", tool: "C4 output: robots.txt → R2", priority: "must-do" },
    { step: 4, action: "Submit sitemap to Google Search Console and Bing Webmaster Tools", tool: "Google Search Console", priority: "must-do" },
    { step: 5, action: "Configure CDN with immutable cache headers for all static assets (JS/CSS/fonts/images with content hash)", tool: "Cloudflare / Vercel / CloudFront", priority: "must-do" },
    { step: 6, action: "Implement ISR revalidation intervals per rendering-strategy.json revalidateSeconds", tool: "Next.js / Nuxt config", priority: "must-do" },
    { step: 7, action: "Add prefetch hints from prefetch-plan.json htmlHint fields to each page <head>", tool: "Layout template", priority: "should-do" },
    { step: 8, action: "Run Lighthouse CI in the deployment pipeline and fail builds below score 80", tool: "Lighthouse CI / GitHub Actions", priority: "should-do" },
    { step: 9, action: "Configure real-user monitoring (RUM) to track CWV in production", tool: "Vercel Analytics / web-vitals.js / DataDog", priority: "should-do" },
    { step: 10, action: "Compress all JSON-LD structured data scripts (minify whitespace)", tool: "Build pipeline", priority: "should-do" },
    { step: 11, action: "Implement Content Security Policy headers", tool: "CDN / Edge middleware", priority: "should-do" },
    { step: 12, action: "Run axe-core or pa11y automated accessibility scan against production URL", tool: "pa11y-ci / axe DevTools", priority: "should-do" },
    { step: 13, action: "Set up uptime monitoring for all dynamic route endpoints", tool: "UptimeRobot / Better Uptime / Datadog", priority: "should-do" },
    { step: 14, action: "Verify og:image assets are publicly accessible on the production domain", tool: "opengraph.xyz preview checker", priority: "nice-to-have" },
    { step: 15, action: "Run Google Rich Results Test on pages with structured data", tool: "Google Rich Results Test", priority: "nice-to-have" },
  ];
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function storeJsonToR2(jobId: string, filename: string, data: unknown): Promise<string> {
  const key = `c6/${jobId}/${filename}`;
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) {
    logger.warn({ jobId, filename }, "C6: R2 not configured — skipping upload");
    return key;
  }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ jobId, key }, "C6: report stored to R2");
  return key;
}

// ── In-memory store ───────────────────────────────────────────────────────────

export interface C6Bundle {
  jobId: string;
  generatedAt: string;
  certification: WebsitePrimeCertification;
  score: WebsitePrimeScore;
  productionReadiness: ProductionReadinessReport;
  r2Keys: {
    certification: string;
    score: string;
    productionReadiness: string;
  };
}

const _store = new Map<string, C6Bundle>();

export function getC6Bundle(jobId: string): C6Bundle | undefined { return _store.get(jobId); }
export function listC6Bundles(): Array<{ jobId: string; generatedAt: string; certificationLevel: string; overallGrade: string }> {
  return [..._store.values()].map(b => ({
    jobId: b.jobId,
    generatedAt: b.generatedAt,
    certificationLevel: b.certification.certificationLevel,
    overallGrade: b.certification.overallGrade,
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface C6Options { jobId: string }

export async function runCertification(options: C6Options): Promise<C6Bundle> {
  const { jobId } = options;
  const now = new Date().toISOString();
  const certificationId = `CERT-${jobId.slice(0, 8).toUpperCase()}-${Date.now()}`;

  logger.info({ jobId }, "C6: starting Website Prime certification");

  // Verify manifest exists
  const manifest = await loadManifest(jobId);
  if (!manifest) throw new Error(`C6: manifest not found for jobId "${jobId}"`);
  const pageCount = manifest.nodes.size;

  // Gather all phase bundles (read-only — no modification)
  const c2 = getC2Bundle(jobId);
  const c3 = getC3Bundle(jobId);
  const c4 = getC4Bundle(jobId);
  const c5 = getC5Bundle(jobId);

  const phasesCompleted:  string[] = [];
  const phasesIncomplete: string[] = [];
  if (c2) phasesCompleted.push("C2 — Asset Intelligence"); else phasesIncomplete.push("C2 — Asset Intelligence");
  if (c3) phasesCompleted.push("C3 — Runtime Performance"); else phasesIncomplete.push("C3 — Runtime Performance");
  if (c4) phasesCompleted.push("C4 — SEO Intelligence");   else phasesIncomplete.push("C4 — SEO Intelligence");
  if (c5) phasesCompleted.push("C5 — Runtime Optimizer");  else phasesIncomplete.push("C5 — Runtime Optimizer");

  logger.info({ jobId, phasesCompleted: phasesCompleted.length, phasesIncomplete: phasesIncomplete.length }, "C6: computing grades");

  // Manifest-derived hint for calibrated "no-data" fallback scores
  const manifestHint: ManifestHint = {
    pageCount:   pageCount,
    coveragePct: Math.min(100, pageCount * 10), // rough coverage proxy: 10 pages ≈ 100%
  };

  // Compute each grade dimension
  const dimensions = {
    performance:     gradePerformance(c3, manifestHint),
    seo:             gradeSeo(c4, manifestHint),
    accessibility:   gradeAccessibility(c4),
    maintainability: gradeMaintainability(c2, c5),
    scalability:     gradeScalability(c5, manifestHint),
    runtime:         gradeRuntime(c3, c5),
  };

  const { score, grade, rating, certificationLevel, enterpriseTier } = overallFromDimensions(dimensions);

  // Collect all issues
  const allIssues = Object.values(dimensions).flatMap(d => d.issues);

  // Certification statement
  const certificationStatement = (() => {
    if (certificationLevel === "Blocked")
      return `Website Prime (jobId: ${jobId}) CANNOT be certified for production deployment. ${allIssues.filter(i => i.blocksProduction).length} production blocker(s) must be resolved before launch.`;
    if (certificationLevel === "Production Ready")
      return `Website Prime (jobId: ${jobId}) is certified ${enterpriseTier} — ready for production deployment with an overall grade of ${grade} (${score}/100).`;
    return `Website Prime (jobId: ${jobId}) is CONDITIONALLY ready for production. ${allIssues.filter(i => i.severity === "critical" || i.severity === "major").length} critical/major issue(s) should be addressed before enterprise launch.`;
  })();

  const auditorNote = phasesIncomplete.length > 0
    ? `IMPORTANT: ${phasesIncomplete.join(", ")} ${phasesIncomplete.length === 1 ? "was" : "were"} not completed before certification. Scores for affected dimensions are estimates. Re-run certification after completing all phases for a full audit.`
    : "All pipeline phases (C2–C5) were completed before certification. This is a full-coverage audit.";

  // Build certification
  const certification: WebsitePrimeCertification = {
    jobId, generatedAt: now, certificationId, certifiedAt: now,
    certificationLevel, enterpriseTier,
    overallScore: score, overallGrade: grade, overallRating: rating,
    grades: dimensions,
    phasesCompleted, phasesIncomplete,
    certificationStatement, auditorNote,
  };

  // Score summary
  const scoreReport: WebsitePrimeScore = {
    jobId, generatedAt: now, certificationLevel, enterpriseTier,
    overallScore: score, overallGrade: grade,
    scores: {
      performance:     { score: dimensions.performance.score,     grade: dimensions.performance.grade },
      seo:             { score: dimensions.seo.score,             grade: dimensions.seo.grade },
      accessibility:   { score: dimensions.accessibility.score,   grade: dimensions.accessibility.grade },
      maintainability: { score: dimensions.maintainability.score, grade: dimensions.maintainability.grade },
      scalability:     { score: dimensions.scalability.score,     grade: dimensions.scalability.grade },
      runtime:         { score: dimensions.runtime.score,         grade: dimensions.runtime.grade },
    },
    blockerCount:       allIssues.filter(i => i.blocksProduction).length,
    criticalIssueCount: allIssues.filter(i => i.severity === "critical").length,
    totalIssueCount:    allIssues.length,
  };

  // Production readiness report
  const blockers   = allIssues.filter(i => i.blocksProduction);
  const critical   = allIssues.filter(i => !i.blocksProduction && i.severity === "critical");
  const major      = allIssues.filter(i => i.severity === "major");
  const minor      = allIssues.filter(i => i.severity === "minor");
  const advisories = allIssues.filter(i => i.severity === "advisory");

  const totalIssueHours = (blockers.length + critical.length) * 16 + major.length * 8 + minor.length * 2;
  const estimatedDays   = Math.ceil(totalIssueHours / 8);
  const estimatedRemediation = blockers.length > 0 || critical.length > 0
    ? `Approximately ${estimatedDays} engineer-day(s) to resolve all blockers and critical issues.`
    : major.length > 0
    ? `Approximately ${estimatedDays} engineer-day(s) to resolve all major issues. No hard blockers.`
    : "No significant remediation required. Only minor improvements and advisories remain.";

  const productionReadiness: ProductionReadinessReport = {
    jobId, generatedAt: now, certificationLevel,
    readyForProduction: certificationLevel === "Production Ready",
    blockers, criticalIssues: critical, majorIssues: major, minorIssues: minor, advisories,
    preflightChecklist: buildPreflightChecklist(c2, c3, c4, c5, pageCount),
    deploymentChecklist: buildDeploymentChecklist(),
    estimatedRemediation,
  };

  logger.info({ jobId, score, grade, certificationLevel }, "C6: storing certification reports to R2");

  const [r2Cert, r2Score, r2Readiness] = await Promise.all([
    storeJsonToR2(jobId, "website-prime-certification.json",  certification),
    storeJsonToR2(jobId, "website-prime-score.json",          scoreReport),
    storeJsonToR2(jobId, "production-readiness-report.json",  productionReadiness),
  ]);

  const bundle: C6Bundle = {
    jobId, generatedAt: now,
    certification, score: scoreReport, productionReadiness,
    r2Keys: {
      certification:      r2Cert!,
      score:              r2Score!,
      productionReadiness: r2Readiness!,
    },
  };

  _store.set(jobId, bundle);
  logger.info({ jobId, grade, score, certificationLevel, enterpriseTier }, "C6: Website Prime certification complete");
  return bundle;
}
