import type { DiscoverySiteGraph } from "@workspace/site-discovery";
import type { SiteGraph } from "@workspace/site-intelligence";
import type { MergeConflict, MergeDecision } from "./types.js";

let seq = 0;
const nextConId = () => `con-cross-${(++seq).toString().padStart(4, "0")}-${Date.now()}`;

// ─── Cross-entity conflict detection ─────────────────────────────────────────
//
// This module detects conflicts that only emerge when looking across entity
// boundaries — issues a single-domain matcher cannot see.

function extractPath(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

// ─── Naming conflict detection ─────────────────────────────────────────────────
//
// A CREATE decision for a component whose name collides with an existing
// component (but was scored too low to be an EXTEND) produces a naming conflict.

export function detectNamingConflicts(decisions: MergeDecision[]): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  const creates = decisions.filter((d) => d.action === "CREATE" && d.entityKind === "component");
  const existingNames = decisions
    .filter((d) => d.target?.graph === "discovery" && d.entityKind === "component")
    .map((d) => d.target!.name?.toLowerCase() ?? "");

  for (const create of creates) {
    const neededName = (create.metadata["neededName"] as string | undefined)?.toLowerCase();
    if (!neededName) continue;

    for (const existing of existingNames) {
      if (!existing) continue;
      // Detect same name with different casing or slight variation
      if (existing === neededName || existing.replace(/[^a-z]/g, "") === neededName.replace(/[^a-z]/g, "")) {
        const conflict: MergeConflict = {
          id: nextConId(),
          kind: "naming-conflict",
          severity: "warning",
          description: `A new component '${create.metadata["neededName"]}' must be created, but a component with a very similar name already exists ('${existing}'). This may cause import confusion.`,
          sourceRef: null,
          targetRef: null,
          resolution: `Use a distinct name for the new component, or verify that the existing '${existing}' can be extended instead.`,
          isBlocker: false,
        };
        conflicts.push(conflict);
        create.conflicts.push(conflict);
        break;
      }
    }
  }

  return conflicts;
}

// ─── Discovery orphan validation ──────────────────────────────────────────────
//
// If we're creating new routes but the discovery graph already marks routes as
// orphans, that's a signal the site's navigation is incomplete.

export function detectNavigationGaps(
  discoveryGraph: DiscoverySiteGraph,
  decisions: MergeDecision[]
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  const creates = decisions.filter((d) => d.action === "CREATE" && d.entityKind === "route");
  if (creates.length === 0) return conflicts;

  const orphanCount = discoveryGraph.orphanPages.length;
  if (orphanCount > 0) {
    const conflict: MergeConflict = {
      id: nextConId(),
      kind: "orphan-route",
      severity: "warning",
      description: `${creates.length} new route(s) will be created, but the existing codebase already has ${orphanCount} orphan page(s) with no inbound navigation. Adding more routes without fixing navigation will worsen discoverability.`,
      sourceRef: null,
      targetRef: null,
      resolution: "Resolve existing orphan routes before adding new ones, or update the site's navigation component to link to all new pages.",
      isBlocker: false,
    };
    conflicts.push(conflict);
  }

  return conflicts;
}

// ─── Route + layout cross-check ───────────────────────────────────────────────
//
// If we're creating routes but no matching layout exists or is being created,
// those routes would have no layout — flag it.

export function detectRouteWithoutLayout(decisions: MergeDecision[]): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  const routeCreates = decisions.filter((d) => d.action === "CREATE" && d.entityKind === "route");
  const layoutCreatesOrExtends = decisions.filter(
    (d) => d.entityKind === "layout" && (d.action === "CREATE" || d.action === "EXTEND")
  );

  if (routeCreates.length > 0 && layoutCreatesOrExtends.length === 0) {
    const conflict: MergeConflict = {
      id: nextConId(),
      kind: "layout-mismatch",
      severity: "error",
      description: `${routeCreates.length} new route(s) are being created, but no layout component covers them (no CREATE or EXTEND layout decisions exist). Routes without layouts will render unstyled content.`,
      sourceRef: null,
      targetRef: null,
      resolution: "Ensure a layout component covers all newly created routes, either by creating a new layout or extending an existing one.",
      isBlocker: true,
    };
    conflicts.push(conflict);
    for (const dec of routeCreates) dec.conflicts.push(conflict);
  }

  return conflicts;
}

// ─── Duplicate scraped slugs in manifest ─────────────────────────────────────

export function detectManifestDuplicates(siteGraph: SiteGraph): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  // SiteGraph already tracks duplicate paths in the NavigationTree
  for (const dup of siteGraph.navigation.duplicatePaths) {
    conflicts.push({
      id: nextConId(),
      kind: "duplicate-route-match",
      severity: "warning",
      description: `Manifest contains duplicate path '${dup.route}' shared by ${dup.nodeIds.length} nodes. These nodes would collide at the same URL when merged.`,
      sourceRef: { id: dup.nodeIds[0] ?? "unknown", path: dup.route, graph: "manifest" },
      targetRef: null,
      resolution: "De-duplicate the source content or apply unique slug suffixes before merging.",
      isBlocker: false,
    });
  }

  return conflicts;
}

// ─── Content type → layout cross-check ───────────────────────────────────────

export function detectContentLayoutMismatches(
  siteGraph: SiteGraph,
  decisions: MergeDecision[]
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  // Find UPDATE decisions on layouts that are missing required components
  const layoutUpdates = decisions.filter(
    (d) => d.action === "UPDATE" && d.entityKind === "layout" && d.conflicts.length > 0
  );

  // If GALLERY content exists but no ImageGrid-style component is being created
  const hasGallery = siteGraph.layoutAssignments.some((la) => la.layout === "GalleryLayout");
  const hasGalleryComponent = decisions.some(
    (d) =>
      d.entityKind === "component" &&
      d.action !== "CREATE" &&
      (d.target?.name?.toLowerCase().includes("gallery") ||
        d.target?.name?.toLowerCase().includes("image"))
  );

  if (hasGallery && !hasGalleryComponent && layoutUpdates.length > 0) {
    const conflict: MergeConflict = {
      id: nextConId(),
      kind: "layout-mismatch",
      severity: "warning",
      description: `Site has GalleryLayout content but no matching gallery component exists or is being extended. Gallery pages may render without proper image grid structure.`,
      sourceRef: null,
      targetRef: null,
      resolution: "Create a GalleryGrid component to properly render gallery content.",
      isBlocker: false,
    };
    conflicts.push(conflict);
  }

  return conflicts;
}
