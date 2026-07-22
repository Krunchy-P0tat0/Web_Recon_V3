/**
 * footer-nav-builder.ts
 *
 * Builds the footer navigation blueprint from the stencil's FooterSpec.
 * Each FooterSpec.linkGroup becomes a FooterNavGroup whose links are
 * resolved against real pages in the RouteMap.
 *
 * Rules:
 *   1. For each FooterSpec.linkGroup, treat each link label as a search term.
 *   2. Try to find a real page matching by slug, route segment, or route map entry.
 *   3. If no real page found, keep the label as a synthetic link (path "#").
 *   4. Legal links (Privacy Policy, Terms, Cookie Policy, Accessibility) are
 *      collected separately and rendered as a legal footer row.
 *   5. Social platforms and newsletter flag are passed through from FooterSpec.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type { FooterNavBlueprint, FooterNavGroup, FooterNavLink } from "./types.js";

const LEGAL_PATTERNS = [
  /privacy/i,
  /terms/i,
  /cookie/i,
  /accessibility/i,
  /legal/i,
  /disclaimer/i,
  /imprint/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLegalLink(label: string): boolean {
  return LEGAL_PATTERNS.some((re) => re.test(label));
}

function findRoute(
  label: string,
  routeMap: SiteGraph["routeMap"],
): { path: string; nodeId: string | null } {
  // Normalise label to a search term
  const term = label.toLowerCase().replace(/\s+/g, "-");

  // Exact slug match
  const bySlug = routeMap.routes.find((r) => r.slug === term);
  if (bySlug) return { path: bySlug.route, nodeId: bySlug.nodeId };

  // Route contains term
  const byRoute = routeMap.routes.find(
    (r) => r.route.toLowerCase().includes(term) || r.slug.includes(term),
  );
  if (byRoute) return { path: byRoute.route, nodeId: byRoute.nodeId };

  // Partial word match (e.g. "Latest Posts" → "posts")
  const words = label.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  for (const word of words) {
    const byWord = routeMap.routes.find(
      (r) => r.route.toLowerCase().includes(word) || r.slug.includes(word),
    );
    if (byWord) return { path: byWord.route, nodeId: byWord.nodeId };
  }

  return { path: "#", nodeId: null };
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildFooterNav(
  siteGraph: SiteGraph,
  blueprint: StencilBlueprint,
): FooterNavBlueprint {
  const spec = blueprint.footer;
  const routeMap = siteGraph.routeMap;

  const groups: FooterNavGroup[] = [];
  const collectedLegalLinks: FooterNavLink[] = [];

  for (const group of spec.linkGroups) {
    const resolved: FooterNavLink[] = [];

    for (const linkLabel of group.links) {
      const legal = isLegalLink(linkLabel);
      const { path, nodeId } = findRoute(linkLabel, routeMap);

      const link: FooterNavLink = {
        label: linkLabel,
        path,
        nodeId,
        isLegal: legal,
      };

      if (legal && spec.hasLegalLinks) {
        collectedLegalLinks.push(link);
      } else {
        resolved.push(link);
      }
    }

    if (resolved.length > 0) {
      groups.push({ heading: group.title, links: resolved });
    }
  }

  // Deduplicate legal links by label
  const seen = new Set<string>();
  const legalLinks = collectedLegalLinks.filter((l) => {
    if (seen.has(l.label)) return false;
    seen.add(l.label);
    return true;
  });

  return {
    groups,
    legalLinks,
    hasSocialLinks: spec.hasSocialLinks,
    socialPlatforms: spec.socialPlatforms,
    hasNewsletter: spec.hasNewsletter,
    hasLogo: spec.hasLogo,
    logoPosition: spec.logoPosition,
    layout: spec.layout,
  };
}
