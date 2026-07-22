/**
 * failure-classifier.ts — Phase F2 Failure Classification Engine
 *
 * Automatically determines WHY a scrape job failed.
 * Every failure is classified before any recovery action is taken.
 *
 * Supported failure classes:
 *   OOM | NetworkTimeout | DNSFailure | HTTPFailure | 429RateLimit |
 *   5xxServerError | BrowserCrash | ParserFailure | StorageFailure |
 *   CheckpointFailure | ManifestFailure | UnexpectedException | Unknown
 *
 * Generates:
 *   failure-classification-report.json
 *   failure-root-cause-report.json
 *   retry-recommendation-report.json
 */

import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FailureClass =
  | "OOM"
  | "NetworkTimeout"
  | "DNSFailure"
  | "HTTPFailure"
  | "429RateLimit"
  | "5xxServerError"
  | "BrowserCrash"
  | "ParserFailure"
  | "StorageFailure"
  | "CheckpointFailure"
  | "ManifestFailure"
  | "UnexpectedException"
  | "Unknown";

export type RetryRecommendation =
  | "retry_immediately"
  | "retry_with_backoff"
  | "retry_after_fix"
  | "do_not_retry";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FailureClassification {
  jobId: string;
  classifiedAt: string;
  failureClass: FailureClass;
  confidence: number;
  rootCause: string;
  retryRecommendation: RetryRecommendation;
  recoveryRecommendation: string;
  riskLevel: RiskLevel;
  errorMessage: string;
  errorStack: string | null;
  retryCount: number;
  maxRetries: number;
  seedUrl: string;
}

export interface FailureClassificationReport {
  generatedAt: string;
  totalClassified: number;
  byClass: Record<FailureClass, number>;
  byRisk: Record<RiskLevel, number>;
  classifications: FailureClassification[];
}

export interface FailureRootCauseReport {
  generatedAt: string;
  totalFailures: number;
  rootCauses: Array<{
    jobId: string;
    failureClass: FailureClass;
    rootCause: string;
    confidence: number;
    riskLevel: RiskLevel;
    classifiedAt: string;
  }>;
}

export interface RetryRecommendationReport {
  generatedAt: string;
  totalJobs: number;
  retryImmediately: number;
  retryWithBackoff: number;
  retryAfterFix: number;
  doNotRetry: number;
  recommendations: Array<{
    jobId: string;
    failureClass: FailureClass;
    retryRecommendation: RetryRecommendation;
    recoveryRecommendation: string;
    retryCount: number;
    maxRetries: number;
  }>;
}

// ---------------------------------------------------------------------------
// Internal pattern registry
// ---------------------------------------------------------------------------

interface ClassifierPattern {
  failureClass: FailureClass;
  patterns: RegExp[];
  confidence: number;
  rootCause: string;
  retryRecommendation: RetryRecommendation;
  recoveryRecommendation: string;
  riskLevel: RiskLevel;
}

const CLASSIFIER_PATTERNS: ClassifierPattern[] = [
  {
    failureClass: "ManifestFailure",
    patterns: [
      /ManifestVerificationError/i,
      /manifest_verification/i,
      /_manifest\.json/i,
      /RestorabilityEnforcementError/i,
      /manifest.*missing/i,
      /restorab/i,
    ],
    confidence: 95,
    rootCause: "The job manifest failed R2 verification or restorability enforcement. The manifest.json is absent, malformed, or failed schema validation.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Verify R2 bucket connectivity and credentials. Check that the emergency manifest re-upload path succeeded. Inspect jobs/{jobId}/_manifest.json in R2.",
    riskLevel: "high",
  },
  {
    failureClass: "OOM",
    patterns: [
      /ENOMEM/i,
      /out of memory/i,
      /allocation failed/i,
      /Cannot allocate memory/i,
      /heap.*out/i,
      /JavaScript heap/i,
      /Reached heap limit/i,
      /process out of memory/i,
    ],
    confidence: 97,
    rootCause: "The worker process exhausted available heap memory. Likely caused by a very large page set, oversized media buffers, or a memory leak in the pipeline.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Reduce MAX_CONCURRENT_JOBS. Increase Node.js --max-old-space-size. Consider splitting large crawl jobs into smaller batches. Check media buffer cleanup in zip_generation stage.",
    riskLevel: "critical",
  },
  {
    failureClass: "429RateLimit",
    patterns: [
      /429/,
      /rate.?limit/i,
      /too many requests/i,
      /throttl/i,
      /request.*quota/i,
      /retry.?after/i,
    ],
    confidence: 95,
    rootCause: "The target server returned HTTP 429 Too Many Requests. The scraper is being rate-limited.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Increase crawl delay between requests. Implement exponential back-off before retry. Consider reducing crawl concurrency for this domain.",
    riskLevel: "medium",
  },
  {
    failureClass: "5xxServerError",
    patterns: [
      /\b5[0-9]{2}\b/,
      /Internal Server Error/i,
      /Bad Gateway/i,
      /Service Unavailable/i,
      /Gateway Timeout/i,
      /HTTP.*5\d\d/i,
      /status.*5\d\d/i,
      /response.*5\d\d/i,
    ],
    confidence: 90,
    rootCause: "The target server returned a 5xx error response. The server is experiencing errors or is temporarily unavailable.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Wait before retrying. If the error persists, check target server health. Consider skipping unreachable URLs and proceeding with the rest.",
    riskLevel: "medium",
  },
  {
    failureClass: "BrowserCrash",
    patterns: [
      /puppeteer/i,
      /chromium/i,
      /Protocol error/i,
      /Target closed/i,
      /Session closed/i,
      /Browser.*crash/i,
      /chrome.*exit/i,
      /browser.*disconnect/i,
      /Page.*crash/i,
      /detached frame/i,
      /Execution context was destroyed/i,
    ],
    confidence: 93,
    rootCause: "The Puppeteer/Chromium browser process crashed or was unexpectedly terminated. This may be caused by a memory spike, a malformed page, or a signal.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Ensure sufficient memory. Consider increasing browser page timeout. The job has a checkpoint; it will resume from the last successful article.",
    riskLevel: "high",
  },
  {
    failureClass: "DNSFailure",
    patterns: [
      /ENOTFOUND/i,
      /ENODATA/i,
      /getaddrinfo/i,
      /DNS.*fail/i,
      /dns.*lookup/i,
      /hostname.*not.*found/i,
      /name.*resolution/i,
    ],
    confidence: 96,
    rootCause: "DNS resolution failed for the target host. The domain may be unreachable, misspelled, or the DNS server is unavailable.",
    retryRecommendation: "retry_after_fix",
    recoveryRecommendation: "Verify the seed URL is correct and the domain is reachable. Check DNS server configuration. If the domain is valid, retry after a short delay.",
    riskLevel: "high",
  },
  {
    failureClass: "NetworkTimeout",
    patterns: [
      /ETIMEDOUT/i,
      /ECONNRESET/i,
      /ECONNREFUSED/i,
      /EHOSTUNREACH/i,
      /socket hang up/i,
      /network.*timeout/i,
      /connection.*timeout/i,
      /read.*timeout/i,
      /request.*timeout/i,
      /navigation.*timeout/i,
      /net::ERR_/i,
    ],
    confidence: 92,
    rootCause: "A network connection to the target timed out or was reset. The server may be slow, firewalled, or the network is unstable.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Increase request timeout values. Check network connectivity from the scraper host. Consider retrying with reduced concurrency.",
    riskLevel: "medium",
  },
  {
    failureClass: "StorageFailure",
    patterns: [
      /ENOENT/i,
      /EACCES/i,
      /ENOSPC/i,
      /R2.*fail/i,
      /S3.*fail/i,
      /upload.*fail/i,
      /storage.*error/i,
      /disk.*full/i,
      /write.*fail/i,
      /cloud.*upload/i,
      /NoSuchBucket/i,
      /AccessDenied/i,
    ],
    confidence: 88,
    rootCause: "A storage operation failed — either local filesystem (disk full, permissions) or cloud storage (R2/S3 credentials, bucket missing, network).",
    retryRecommendation: "retry_after_fix",
    recoveryRecommendation: "Check R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME secrets. Verify the R2 bucket exists and is accessible. Check local disk space.",
    riskLevel: "high",
  },
  {
    failureClass: "CheckpointFailure",
    patterns: [
      /checkpoint/i,
      /pipeline\.json/i,
      /manifest checkpoint/i,
      /loadManifest.*fail/i,
      /saveManifest.*fail/i,
      /execution manifest/i,
    ],
    confidence: 85,
    rootCause: "A checkpoint read or write failed. The job may not be able to resume from its last saved state.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "The job will restart from the beginning (safe, idempotent). Check local storage write permissions and available disk space.",
    riskLevel: "medium",
  },
  {
    failureClass: "ParserFailure",
    patterns: [
      /SyntaxError/i,
      /JSON\.parse/i,
      /Unexpected token/i,
      /unexpected.*end.*json/i,
      /parse.*error/i,
      /cheerio/i,
      /dom.*parse/i,
      /invalid.*json/i,
      /malformed/i,
    ],
    confidence: 87,
    rootCause: "A parser failed to process content returned by the target site. The page may contain malformed HTML/JSON or an unexpected content type.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Inspect the raw content returned for the failing URL. The target page may have changed structure. Parser errors on individual articles are non-fatal; a full job failure suggests a structural issue.",
    riskLevel: "medium",
  },
  {
    failureClass: "HTTPFailure",
    patterns: [
      /HTTP.*4[0-9]{2}/i,
      /status.*4[0-9]{2}/i,
      /response.*4[0-9]{2}/i,
      /\b4[0-9]{2}\b.*error/i,
      /fetch.*failed/i,
      /request.*failed/i,
    ],
    confidence: 82,
    rootCause: "An HTTP request returned a 4xx error (excluding 429). The target resource may be gone, forbidden, or require authentication.",
    retryRecommendation: "retry_after_fix",
    recoveryRecommendation: "Check if the target URL requires authentication. Verify the seed URL is accessible in a browser. 404s on individual articles are normal; a full job failure suggests the seed URL itself is inaccessible.",
    riskLevel: "medium",
  },
  {
    failureClass: "UnexpectedException",
    patterns: [
      /TypeError/i,
      /ReferenceError/i,
      /Cannot read propert/i,
      /Cannot set propert/i,
      /is not a function/i,
      /is not defined/i,
      /undefined is not/i,
      /null is not/i,
    ],
    confidence: 75,
    rootCause: "An unexpected JavaScript exception occurred in the pipeline. This typically indicates a code bug or an unexpected shape of external data.",
    retryRecommendation: "retry_with_backoff",
    recoveryRecommendation: "Inspect the full error stack trace. The job has checkpoint recovery; retry may succeed if the bad data was transient. If the error is consistent, a code fix is required.",
    riskLevel: "high",
  },
];

// ---------------------------------------------------------------------------
// In-memory report store (written to disk after each classification)
// ---------------------------------------------------------------------------

const _classifications = new Map<string, FailureClassification>();

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

function matchPattern(message: string, stack: string | null): ClassifierPattern | null {
  const haystack = `${message} ${stack ?? ""}`;

  let best: ClassifierPattern | null = null;
  let bestScore = 0;

  for (const pattern of CLASSIFIER_PATTERNS) {
    let matches = 0;
    for (const re of pattern.patterns) {
      if (re.test(haystack)) matches++;
    }
    if (matches === 0) continue;

    const score = matches * pattern.confidence;
    if (score > bestScore) {
      bestScore = score;
      best = pattern;
    }
  }

  return best;
}

export interface ClassifyOptions {
  jobId: string;
  seedUrl: string;
  errorMessage: string;
  errorStack?: string | null;
  retryCount: number;
  maxRetries: number;
}

/**
 * Classify a job failure and register it in the in-memory store.
 * Always returns a FailureClassification — never throws.
 */
export function classifyFailure(opts: ClassifyOptions): FailureClassification {
  const match = matchPattern(opts.errorMessage, opts.errorStack ?? null);

  const classification: FailureClassification = match
    ? {
        jobId: opts.jobId,
        classifiedAt: new Date().toISOString(),
        failureClass: match.failureClass,
        confidence: match.confidence,
        rootCause: match.rootCause,
        retryRecommendation: opts.retryCount >= opts.maxRetries
          ? "do_not_retry"
          : match.retryRecommendation,
        recoveryRecommendation: match.recoveryRecommendation,
        riskLevel: match.riskLevel,
        errorMessage: opts.errorMessage,
        errorStack: opts.errorStack ?? null,
        retryCount: opts.retryCount,
        maxRetries: opts.maxRetries,
        seedUrl: opts.seedUrl,
      }
    : {
        jobId: opts.jobId,
        classifiedAt: new Date().toISOString(),
        failureClass: "Unknown",
        confidence: 30,
        rootCause: "No pattern matched the error message. The failure cause is unknown.",
        retryRecommendation: opts.retryCount >= opts.maxRetries
          ? "do_not_retry"
          : "retry_with_backoff",
        recoveryRecommendation: "Inspect the full error message and stack trace manually. Check server logs for context around the failure timestamp.",
        riskLevel: "medium",
        errorMessage: opts.errorMessage,
        errorStack: opts.errorStack ?? null,
        retryCount: opts.retryCount,
        maxRetries: opts.maxRetries,
        seedUrl: opts.seedUrl,
      };

  _classifications.set(opts.jobId, classification);

  logger.warn(
    {
      jobId: opts.jobId,
      failureClass: classification.failureClass,
      confidence: classification.confidence,
      riskLevel: classification.riskLevel,
      retryRecommendation: classification.retryRecommendation,
    },
    "FAILURE-CLASSIFIER: job failure classified"
  );

  persistReports().catch((err) => {
    logger.warn({ err }, "FAILURE-CLASSIFIER: could not persist reports (non-fatal)");
  });

  return classification;
}

/**
 * Return the last classification for a job, or null if not classified yet.
 */
export function getClassification(jobId: string): FailureClassification | null {
  return _classifications.get(jobId) ?? null;
}

/**
 * All classifications currently in memory.
 */
export function allClassifications(): FailureClassification[] {
  return Array.from(_classifications.values());
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildClassificationReport(list: FailureClassification[]): FailureClassificationReport {
  const byClass = {} as Record<FailureClass, number>;
  const byRisk = {} as Record<RiskLevel, number>;

  for (const c of list) {
    byClass[c.failureClass] = (byClass[c.failureClass] ?? 0) + 1;
    byRisk[c.riskLevel] = (byRisk[c.riskLevel] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalClassified: list.length,
    byClass,
    byRisk,
    classifications: list,
  };
}

function buildRootCauseReport(list: FailureClassification[]): FailureRootCauseReport {
  return {
    generatedAt: new Date().toISOString(),
    totalFailures: list.length,
    rootCauses: list.map((c) => ({
      jobId: c.jobId,
      failureClass: c.failureClass,
      rootCause: c.rootCause,
      confidence: c.confidence,
      riskLevel: c.riskLevel,
      classifiedAt: c.classifiedAt,
    })),
  };
}

function buildRetryReport(list: FailureClassification[]): RetryRecommendationReport {
  const counts = {
    retry_immediately: 0,
    retry_with_backoff: 0,
    retry_after_fix: 0,
    do_not_retry: 0,
  };

  for (const c of list) {
    counts[c.retryRecommendation]++;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalJobs: list.length,
    retryImmediately: counts.retry_immediately,
    retryWithBackoff: counts.retry_with_backoff,
    retryAfterFix: counts.retry_after_fix,
    doNotRetry: counts.do_not_retry,
    recommendations: list.map((c) => ({
      jobId: c.jobId,
      failureClass: c.failureClass,
      retryRecommendation: c.retryRecommendation,
      recoveryRecommendation: c.recoveryRecommendation,
      retryCount: c.retryCount,
      maxRetries: c.maxRetries,
    })),
  };
}

// ---------------------------------------------------------------------------
// On-demand report getters (no disk write — for HTTP consumption)
// ---------------------------------------------------------------------------

/** FailureClassificationReport computed fresh from the in-memory store. */
export function getFailureClassificationReport(): FailureClassificationReport {
  return buildClassificationReport(allClassifications());
}

/** FailureRootCauseReport computed fresh from the in-memory store. */
export function getFailureRootCauseReport(): FailureRootCauseReport {
  return buildRootCauseReport(allClassifications());
}

/** RetryRecommendationReport computed fresh from the in-memory store. */
export function getRetryRecommendationReport(): RetryRecommendationReport {
  return buildRetryReport(allClassifications());
}

export interface ClassifierPatternSummary {
  failureClass: FailureClass;
  confidence: number;
  rootCause: string;
  retryRecommendation: RetryRecommendation;
  recoveryRecommendation: string;
  riskLevel: RiskLevel;
  patternCount: number;
}

/**
 * Sanitized reference table of every classifier pattern (excludes raw
 * regexes — just the count — so the UI can show "why" a class was matched).
 */
export function getClassifierPatternCatalog(): ClassifierPatternSummary[] {
  return CLASSIFIER_PATTERNS.map((p) => ({
    failureClass: p.failureClass,
    confidence: p.confidence,
    rootCause: p.rootCause,
    retryRecommendation: p.retryRecommendation,
    recoveryRecommendation: p.recoveryRecommendation,
    riskLevel: p.riskLevel,
    patternCount: p.patterns.length,
  }));
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const REPORT_DIR = process.cwd();

async function persistReports(): Promise<void> {
  const list = allClassifications();

  await Promise.all([
    writeFile(
      join(REPORT_DIR, "failure-classification-report.json"),
      JSON.stringify(buildClassificationReport(list), null, 2),
      "utf8"
    ),
    writeFile(
      join(REPORT_DIR, "failure-root-cause-report.json"),
      JSON.stringify(buildRootCauseReport(list), null, 2),
      "utf8"
    ),
    writeFile(
      join(REPORT_DIR, "retry-recommendation-report.json"),
      JSON.stringify(buildRetryReport(list), null, 2),
      "utf8"
    ),
  ]);
}

/**
 * Load any existing classification reports from disk at startup.
 * Merges them into the in-memory store so reports survive server restarts.
 */
export async function loadPersistedClassifications(): Promise<void> {
  try {
    const raw = await readFile(
      join(REPORT_DIR, "failure-classification-report.json"),
      "utf8"
    );
    const report = JSON.parse(raw) as FailureClassificationReport;
    for (const c of report.classifications) {
      if (!_classifications.has(c.jobId)) {
        _classifications.set(c.jobId, c);
      }
    }
    logger.info(
      { loaded: report.classifications.length },
      "FAILURE-CLASSIFIER: loaded persisted classifications"
    );
  } catch {
    // File absent on first start — not an error
  }
}

/**
 * Force-write all three reports to disk immediately.
 * Used by the supervisor or on-demand via API.
 */
export async function flushReports(): Promise<{
  classificationReport: FailureClassificationReport;
  rootCauseReport: FailureRootCauseReport;
  retryReport: RetryRecommendationReport;
}> {
  const list = allClassifications();
  const classificationReport = buildClassificationReport(list);
  const rootCauseReport = buildRootCauseReport(list);
  const retryReport = buildRetryReport(list);

  await Promise.all([
    writeFile(
      join(REPORT_DIR, "failure-classification-report.json"),
      JSON.stringify(classificationReport, null, 2),
      "utf8"
    ),
    writeFile(
      join(REPORT_DIR, "failure-root-cause-report.json"),
      JSON.stringify(rootCauseReport, null, 2),
      "utf8"
    ),
    writeFile(
      join(REPORT_DIR, "retry-recommendation-report.json"),
      JSON.stringify(retryReport, null, 2),
      "utf8"
    ),
  ]);

  return { classificationReport, rootCauseReport, retryReport };
}
