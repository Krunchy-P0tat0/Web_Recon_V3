/**
 * Phase 4.7 — Navigation Intelligence
 *
 * Types for the NavigationBlueprint and NavigationReport output.
 * Four navigation surfaces: top-nav, mega-menu, sidebar, footer-nav.
 * Breadcrumb trails are generated per-page.
 */

// ── Top Navigation ────────────────────────────────────────────────────────────

export interface TopNavItem {
  /** Resolved display label */
  label: string;
  /** Resolved route path (e.g. "/", "/blog", "/blog/tech") */
  path: string;
  /** Original page nodeId (null for synthetic entries like CTA) */
  nodeId: string | null;
  /** Child items when this is a dropdown parent */
  children: TopNavItem[];
  /** Whether this item carries a dropdown */
  hasDropdown: boolean;
  /** Whether this item is a CTA button (special rendering) */
  isCta: boolean;
  /** Whether this item represents a search trigger */
  isSearch: boolean;
  /** Whether this was an overflow item promoted into "More" */
  isOverflow: boolean;
}

// ── Mega Menu ─────────────────────────────────────────────────────────────────

export interface MegaMenuLink {
  label: string;
  path: string;
  nodeId: string | null;
  /** Optional short description for link cards */
  description: string | null;
}

export interface MegaMenuColumn {
  /** Column heading (usually category label) */
  heading: string;
  /** Category nodeId driving this column */
  categoryId: string | null;
  links: MegaMenuLink[];
}

export interface MegaMenuSection {
  /** The top-nav item this mega-menu belongs to */
  triggerLabel: string;
  triggerPath: string;
  columns: MegaMenuColumn[];
  /** Total link count across all columns */
  totalLinks: number;
}

/** Full mega-menu (multiple sections, one per top-level category with enough depth) */
export interface MegaMenuBlueprint {
  sections: MegaMenuSection[];
  isEnabled: boolean;
}

// ── Sidebar Navigation ────────────────────────────────────────────────────────

export interface SidebarNode {
  label: string;
  path: string;
  nodeId: string | null;
  depth: number;
  children: SidebarNode[];
  isExpanded: boolean;
  isLeaf: boolean;
}

export interface SidebarSection {
  /** Optional grouping heading (e.g. "Getting Started", "API Reference") */
  heading: string | null;
  nodes: SidebarNode[];
}

export interface SidebarBlueprint {
  sections: SidebarSection[];
  /** Flattened ordered list of all sidebar items (useful for prev/next step-nav) */
  flatItems: Array<{ label: string; path: string; nodeId: string | null; depth: number }>;
  totalItems: number;
  isEnabled: boolean;
}

// ── Footer Navigation ─────────────────────────────────────────────────────────

export interface FooterNavLink {
  label: string;
  path: string;
  nodeId: string | null;
  /** true for legal/static links (Privacy Policy, Terms, etc.) */
  isLegal: boolean;
}

export interface FooterNavGroup {
  /** Column heading */
  heading: string;
  links: FooterNavLink[];
}

export interface FooterNavBlueprint {
  groups: FooterNavGroup[];
  /** Legal links row (copyright, privacy, terms) */
  legalLinks: FooterNavLink[];
  hasSocialLinks: boolean;
  socialPlatforms: string[];
  hasNewsletter: boolean;
  hasLogo: boolean;
  logoPosition: "left" | "center";
  layout: string;
}

// ── Breadcrumbs ───────────────────────────────────────────────────────────────

export interface BreadcrumbItem {
  label: string;
  path: string;
  nodeId: string;
  isCurrentPage: boolean;
}

/** Breadcrumb trail for one page */
export interface BreadcrumbTrail {
  nodeId: string;
  url: string;
  items: BreadcrumbItem[];
}

// ── NavigationBlueprint (the unified output) ──────────────────────────────────

export interface NavigationBlueprint {
  /** Primary top navigation bar */
  topNav: TopNavItem[];
  /** Mega-menu (null when stencil does not support mega-menu) */
  megaMenu: MegaMenuBlueprint;
  /** Persistent sidebar (null when stencil does not support sidebar) */
  sidebar: SidebarBlueprint;
  /** Footer link groups and metadata */
  footerNav: FooterNavBlueprint;
  /** Per-page breadcrumb trails keyed by nodeId */
  breadcrumbs: Record<string, BreadcrumbTrail>;
}

// ── Stats & Report ────────────────────────────────────────────────────────────

export interface NavigationStats {
  topNavItemCount: number;
  topNavDropdownCount: number;
  megaMenuSectionCount: number;
  megaMenuTotalLinks: number;
  sidebarTotalItems: number;
  sidebarSectionCount: number;
  footerGroupCount: number;
  footerTotalLinks: number;
  breadcrumbPageCount: number;
  overflowItemCount: number;
  hasMegaMenu: boolean;
  hasSidebar: boolean;
}

export interface NavigationReport {
  jobId: string;
  seedUrl: string;
  stencilId: string;
  generatedAt: string;
  blueprint: NavigationBlueprint;
  stats: NavigationStats;
}
