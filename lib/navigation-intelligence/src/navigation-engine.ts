/**
 * navigation-engine.ts — Phase 4.7
 *
 * Orchestrates all four navigation builders into a single NavigationBlueprint.
 *
 * Call:
 *   buildNavigation({ jobId, seedUrl, stencilId, siteGraph, blueprint })
 *     → NavigationReport
 *
 * Non-fatal per surface: if one builder throws, that surface is left empty
 * rather than crashing the entire navigation phase.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type {
  NavigationBlueprint,
  NavigationReport,
  NavigationStats,
  TopNavItem,
  MegaMenuBlueprint,
  SidebarBlueprint,
  FooterNavBlueprint,
} from "./types.js";
import { buildTopNav } from "./top-nav-builder.js";
import { buildMegaMenu } from "./mega-menu-builder.js";
import { buildSidebar } from "./sidebar-builder.js";
import { buildFooterNav } from "./footer-nav-builder.js";
import { buildBreadcrumbs } from "./breadcrumb-builder.js";

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface BuildNavigationInput {
  jobId: string;
  seedUrl: string;
  stencilId: string;
  siteGraph: SiteGraph;
  blueprint: StencilBlueprint;
}

// ── Fallbacks ─────────────────────────────────────────────────────────────────

const EMPTY_MEGA_MENU: MegaMenuBlueprint = { sections: [], isEnabled: false };
const EMPTY_SIDEBAR: SidebarBlueprint = {
  sections: [],
  flatItems: [],
  totalItems: 0,
  isEnabled: false,
};
const EMPTY_FOOTER: FooterNavBlueprint = {
  groups: [],
  legalLinks: [],
  hasSocialLinks: false,
  socialPlatforms: [],
  hasNewsletter: false,
  hasLogo: false,
  logoPosition: "left",
  layout: "minimal",
};

// ── Stats ─────────────────────────────────────────────────────────────────────

function computeStats(blueprint: NavigationBlueprint): NavigationStats {
  const topNavDropdowns = blueprint.topNav.filter((i) => i.hasDropdown).length;
  const overflowCount = blueprint.topNav.filter((i) => i.isOverflow).length;

  return {
    topNavItemCount: blueprint.topNav.length,
    topNavDropdownCount: topNavDropdowns,
    megaMenuSectionCount: blueprint.megaMenu.sections.length,
    megaMenuTotalLinks: blueprint.megaMenu.sections.reduce((n, s) => n + s.totalLinks, 0),
    sidebarTotalItems: blueprint.sidebar.totalItems,
    sidebarSectionCount: blueprint.sidebar.sections.length,
    footerGroupCount: blueprint.footerNav.groups.length,
    footerTotalLinks: blueprint.footerNav.groups.reduce((n, g) => n + g.links.length, 0),
    breadcrumbPageCount: Object.keys(blueprint.breadcrumbs).length,
    overflowItemCount: overflowCount,
    hasMegaMenu: blueprint.megaMenu.isEnabled,
    hasSidebar: blueprint.sidebar.isEnabled,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function safeBuild<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function buildNavigation(input: BuildNavigationInput): NavigationReport {
  const { jobId, seedUrl, stencilId, siteGraph, blueprint } = input;

  const topNav: TopNavItem[] = safeBuild(
    () => buildTopNav(siteGraph, blueprint),
    [],
  );

  const megaMenu: MegaMenuBlueprint = safeBuild(
    () => buildMegaMenu(siteGraph, blueprint),
    EMPTY_MEGA_MENU,
  );

  const sidebar: SidebarBlueprint = safeBuild(
    () => buildSidebar(siteGraph, blueprint),
    EMPTY_SIDEBAR,
  );

  const footerNav: FooterNavBlueprint = safeBuild(
    () => buildFooterNav(siteGraph, blueprint),
    EMPTY_FOOTER,
  );

  const breadcrumbs = safeBuild(
    () => buildBreadcrumbs(siteGraph, blueprint),
    {},
  );

  const navBlueprint: NavigationBlueprint = {
    topNav,
    megaMenu,
    sidebar,
    footerNav,
    breadcrumbs,
  };

  return {
    jobId,
    seedUrl,
    stencilId,
    generatedAt: new Date().toISOString(),
    blueprint: navBlueprint,
    stats: computeStats(navBlueprint),
  };
}
