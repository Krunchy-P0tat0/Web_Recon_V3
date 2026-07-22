import type { DiscoveredDataSource } from "@workspace/site-discovery";
import type { SiteGraph } from "@workspace/site-intelligence";
import type { MergeConflict, MergeDecision } from "./types.js";

let seq = 0;
const nextDecId = () => `dec-ds-${(++seq).toString().padStart(4, "0")}`;
const nextConId = () => `con-ds-${seq.toString().padStart(4, "0")}-${Date.now()}`;

// ─── Required datasource inference ────────────────────────────────────────────
//
// The SiteGraph doesn't list data sources directly — we infer what's needed
// from the content volume, media volume, and category complexity.

interface InferredDataNeed {
  kind: "database" | "cms" | "cache" | "file-system";
  reason: string;
  confidence: number;
}

function inferDataNeeds(siteGraph: SiteGraph): InferredDataNeed[] {
  const needs: InferredDataNeed[] = [];
  const { totalNodes, contentNodes } = siteGraph;
  const hasMedia =
    (siteGraph.assetGraph.assetsByType["image"] ?? 0) > 0 ||
    (siteGraph.assetGraph.assetsByType["video"] ?? 0) > 0;
  const hasTaxonomy =
    siteGraph.categoryGraph.categories.length > 0 ||
    siteGraph.categoryGraph.tags.length > 0;

  // Always need a database if more than a handful of pages
  if (contentNodes > 5) {
    needs.push({
      kind: "database",
      reason: `Site has ${contentNodes} content nodes — a database or CMS is required to persist and query scraped content.`,
      confidence: 0.9,
    });
  }

  // CMS if content is editorial/structured
  if (contentNodes > 10 && hasTaxonomy) {
    needs.push({
      kind: "cms",
      reason: `Site has ${siteGraph.categoryGraph.categories.length} categories and taxonomy structure — a CMS integration is recommended for content management.`,
      confidence: 0.75,
    });
  }

  // Cache if high volume
  if (totalNodes > 50) {
    needs.push({
      kind: "cache",
      reason: `Large site (${totalNodes} total nodes) — a cache layer (Redis/Upstash) is recommended for performance.`,
      confidence: 0.6,
    });
  }

  // Object storage if media present
  if (hasMedia) {
    needs.push({
      kind: "file-system",
      reason: `Site has ${siteGraph.assetGraph.assetsByType["image"] ?? 0} images — object storage (S3/R2/Cloudinary) is needed for media assets.`,
      confidence: 0.85,
    });
  }

  return needs;
}

// ─── Provider quality scoring ─────────────────────────────────────────────────

const KIND_PREFERRED_PROVIDERS: Record<string, string[]> = {
  database: ["prisma", "drizzle", "supabase", "mongoose"],
  cms: ["contentful", "sanity", "strapi", "payload", "wordpress", "ghost", "prismic"],
  cache: ["redis", "upstash"],
  "file-system": ["s3", "cloudinary", "uploadthing"],
};

function findDatasourcesForKind(
  kind: string,
  sources: DiscoveredDataSource[]
): DiscoveredDataSource[] {
  const preferred = KIND_PREFERRED_PROVIDERS[kind] ?? [];
  return sources.filter(
    (ds) => ds.kind === kind || preferred.includes(ds.provider)
  );
}

// ─── Main matcher ─────────────────────────────────────────────────────────────

export interface DatasourceMatchResult {
  decisions: MergeDecision[];
  conflicts: MergeConflict[];
}

export function matchDataSources(
  discoveredSources: DiscoveredDataSource[],
  siteGraph: SiteGraph
): DatasourceMatchResult {
  seq = 0;
  const decisions: MergeDecision[] = [];
  const conflicts: MergeConflict[] = [];
  const coveredSourceIds = new Set<string>();

  const inferredNeeds = inferDataNeeds(siteGraph);

  for (const need of inferredNeeds) {
    const candidates = findDatasourcesForKind(need.kind, discoveredSources);

    if (candidates.length === 0) {
      decisions.push({
        id: nextDecId(),
        action: "CREATE",
        entityKind: "datasource",
        reason: `Scraped content requires a '${need.kind}' integration (${need.reason}), but none is detected in the codebase.`,
        confidence: need.confidence,
        source: null,
        target: null,
        conflicts: [],
        metadata: { requiredKind: need.kind, inferredReason: need.reason },
      });
      continue;
    }

    // Pick highest-confidence existing source
    const best = candidates.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
    coveredSourceIds.add(best.id);

    // Multiple datasources of the same kind → schema-collision warning
    if (candidates.length > 1) {
      const conflict: MergeConflict = {
        id: nextConId(),
        kind: "schema-collision",
        severity: "warning",
        description: `Multiple '${need.kind}' data sources detected: ${candidates.map((c) => c.provider).join(", ")}. Scraped content will be routed to '${best.provider}' (highest confidence: ${(best.confidence * 100).toFixed(0)}%), but overlapping schemas may cause data conflicts.`,
        sourceRef: null,
        targetRef: { id: best.id, name: best.provider, graph: "discovery" },
        resolution: `Consolidate to a single '${need.kind}' provider or explicitly partition the data between them.`,
        isBlocker: false,
      };
      conflicts.push(conflict);

      decisions.push({
        id: nextDecId(),
        action: "UPDATE",
        entityKind: "datasource",
        reason: `Existing '${best.provider}' (${need.kind}) will receive scraped content, but ${candidates.length - 1} other ${need.kind} source(s) exist. Schema must be updated to accommodate new content types.`,
        confidence: best.confidence * 0.8,
        source: null,
        target: { id: best.id, name: best.provider, graph: "discovery" },
        conflicts: [conflict],
        metadata: {
          provider: best.provider,
          kind: need.kind,
          allCandidates: candidates.map((c) => ({ provider: c.provider, confidence: c.confidence })),
          schemaFiles: best.schemaFiles,
        },
      });
    } else {
      decisions.push({
        id: nextDecId(),
        action: "EXTEND",
        entityKind: "datasource",
        reason: `Existing '${best.provider}' (${need.kind}) can be extended with new content schemas to accommodate scraped data. No new integration needed.`,
        confidence: best.confidence,
        source: null,
        target: { id: best.id, name: best.provider, graph: "discovery" },
        conflicts: [],
        metadata: {
          provider: best.provider,
          kind: need.kind,
          schemaFiles: best.schemaFiles,
          envVars: best.envVarsReferenced,
        },
      });
    }
  }

  // Flag high-confidence data sources not needed by scraped content
  for (const ds of discoveredSources) {
    if (coveredSourceIds.has(ds.id)) continue;
    if (ds.confidence < 0.4) continue; // skip low-confidence detections

    decisions.push({
      id: nextDecId(),
      action: "IGNORE",
      entityKind: "datasource",
      reason: `Data source '${ds.provider}' (${ds.kind}) exists in the codebase but is not required for the scraped content merge. Preserve as-is.`,
      confidence: 0.88,
      source: null,
      target: { id: ds.id, name: ds.provider, graph: "discovery" },
      conflicts: [],
      metadata: { provider: ds.provider, kind: ds.kind, confidence: ds.confidence },
    });
  }

  return { decisions, conflicts };
}
