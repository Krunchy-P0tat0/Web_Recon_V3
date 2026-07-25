import type { ContentType, LayoutType } from "@workspace/site-intelligence";
import type { PageType, ComponentType } from "@workspace/stencil-generator";

export type { ContentType, LayoutType, PageType, ComponentType };

// ─── Stencil identifier ───────────────────────────────────────────────────────

export type StencilId =
  | "agency"
  | "blog"
  | "magazine"
  | "portfolio"
  | "documentation"
  | "marketplace"
  | "directory"
  | "wedding";

// ─── Navigation structure vocabulary ─────────────────────────────────────────

/**
 * Enumeration of navigation structures a stencil can declare support for.
 * These map to structural patterns in the NavigationBlueprint output of
 * @workspace/stencil-generator, not to individual UI components.
 */
export type NavigationStructure =
  | "primary-header"     // Horizontal top-bar navigation
  | "sidebar"            // Vertical side navigation panel
  | "mega-menu"          // Multi-column dropdown from primary-header
  | "breadcrumbs"        // Hierarchical ancestor trail
  | "footer-grouped"     // Footer divided into labelled link groups
  | "tabs"               // Tabbed section switcher
  | "pagination"         // Page-number or prev/next navigation
  | "tag-cloud"          // Tag-based discovery navigation
  | "category-tree"      // Collapsible hierarchical category tree
  | "step-nav"           // Sequential step-by-step navigation (docs/guides)
  | "filter-bar"         // Filter controls for browsing/search
  | "contextual-links";  // In-content related/next/prev links

// ─── Content capability ───────────────────────────────────────────────────────

/**
 * Describes how a stencil handles a particular ContentType.
 *  primary   — the stencil is optimised for this content type
 *  supported — works well but is not the primary focus
 *  partial   — basic support; some features may be degraded
 */
export type ContentSupport = "primary" | "supported" | "partial";

export interface ContentCapability {
  contentType: ContentType;
  support: ContentSupport;
  notes: string;
}

// ─── Layout capability ────────────────────────────────────────────────────────

export interface LayoutCapability {
  layout: LayoutType;
  /** Page types this layout is used for within this stencil */
  usedForPageTypes: PageType[];
  isPrimary: boolean;
}

// ─── Page type capability ─────────────────────────────────────────────────────

export interface PageTypeCapability {
  pageType: PageType;
  isRequired: boolean;
  notes: string;
}

// ─── Stencil definition ───────────────────────────────────────────────────────

export interface StencilDefinition {
  id: StencilId;
  displayName: string;
  description: string;
  version: "1.0";

  /** Content types this stencil is designed to present */
  supportedContent: ContentCapability[];
  /** Layout slots this stencil uses and how */
  supportedLayouts: LayoutCapability[];
  /** Navigation structures this stencil includes */
  supportedNavigationStructures: NavigationStructure[];
  /** Page types this stencil can generate */
  supportedPageTypes: PageTypeCapability[];

  /** Components that must always be present */
  requiredComponents: ComponentType[];
  /** Components that are optional but commonly used */
  optionalComponents: ComponentType[];

  /** The stencil's dominant page type (e.g. "article" for Blog) */
  primaryPageType: PageType;
  /** The stencil's most-used layout */
  primaryLayout: LayoutType;

  /** Descriptive tags for search/filtering the registry */
  tags: string[];
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface StencilRegistryStats {
  totalStencils: number;
  byPrimaryLayout: Record<LayoutType, number>;
  byPrimaryPageType: Record<PageType, number>;
  totalContentCapabilities: number;
  totalNavigationStructures: number;
}

export interface StencilRegistry {
  version: "1.0";
  generatedAt: string;
  stats: StencilRegistryStats;
  stencils: StencilDefinition[];
  /** Fast lookup by StencilId */
  stencilIndex: Record<StencilId, StencilDefinition>;
}

// ─── Export result ────────────────────────────────────────────────────────────

export interface ExportRegistryResult {
  success: boolean;
  outputPath: string;
  bytesWritten: number;
  errors: string[];
}
