// ─── Framework ───────────────────────────────────────────────────────────────

export type Framework =
  | "nextjs"
  | "react"
  | "astro"
  | "express"
  | "laravel"
  | "wordpress"
  | "unknown";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "composer" | "unknown";

export type FrameworkFeature =
  | "app-router"
  | "pages-router"
  | "server-actions"
  | "api-routes"
  | "middleware"
  | "edge-runtime"
  | "ssr"
  | "ssg"
  | "isr"
  | "file-system-routing"
  | "dynamic-routes"
  | "catch-all-routes"
  | "optional-catch-all-routes"
  | "layouts"
  | "loading-states"
  | "error-boundaries"
  | "rest-api"
  | "graphql"
  | "trpc"
  | "php-routing"
  | "blade-templates"
  | "eloquent"
  | "wp-hooks"
  | "wp-shortcodes"
  | "wp-rest-api"
  | "mdx"
  | "markdown-pages"
  | "content-collections"
  | "react-server-components";

export interface FrameworkDetectionResult {
  primary: Framework;
  secondary: Framework[];
  confidence: number;
  version: string | null;
  features: FrameworkFeature[];
  isMonorepo: boolean;
  packageManager: PackageManager;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";
export type RouteType = "page" | "api" | "layout" | "middleware" | "redirect" | "dynamic";
export type PageType = "static" | "dynamic" | "catch-all" | "optional-catch-all";

export interface DiscoveredRoute {
  id: string;
  path: string;
  filePath: string;
  routeType: RouteType;
  pageType: PageType;
  methods: RouteMethod[];
  isDynamic: boolean;
  params: string[];
  layoutId: string | null;
  parentRouteId: string | null;
  childRouteIds: string[];
  isOrphan: boolean;
  duplicateOf: string | null;
  framework: Framework;
  depth: number;
}

// ─── Layouts ─────────────────────────────────────────────────────────────────

export interface DiscoveredLayout {
  id: string;
  name: string;
  filePath: string;
  framework: Framework;
  wrapsRouteIds: string[];
  components: string[];
  hasHeader: boolean;
  hasFooter: boolean;
  hasNav: boolean;
  hasSidebar: boolean;
  nestingLevel: number;
}

// ─── Components ──────────────────────────────────────────────────────────────

export type ComponentType =
  | "layout"
  | "page"
  | "ui"
  | "form"
  | "navigation"
  | "data-display"
  | "feedback"
  | "media"
  | "utility"
  | "unknown";

export interface ComponentProp {
  name: string;
  type: string;
  required: boolean;
  hasDefault: boolean;
}

export interface DiscoveredComponent {
  id: string;
  name: string;
  filePath: string;
  isReusable: boolean;
  usedInFiles: string[];
  usedInRouteIds: string[];
  props: ComponentProp[];
  hasDefaultExport: boolean;
  hasNamedExport: boolean;
  componentType: ComponentType;
  isClientComponent: boolean;
  isServerComponent: boolean;
}

// ─── API Endpoints ────────────────────────────────────────────────────────────

export interface DiscoveredApiEndpoint {
  id: string;
  path: string;
  methods: RouteMethod[];
  filePath: string;
  framework: Framework;
  isAuth: boolean;
  hasValidation: boolean;
  returnsJson: boolean;
  paramNames: string[];
  queryParams: string[];
  handlerName: string | null;
}

// ─── Data Sources ─────────────────────────────────────────────────────────────

export type DataSourceKind = "database" | "cms" | "external-api" | "file-system" | "cache" | "auth";

export type DataSourceProvider =
  | "prisma"
  | "drizzle"
  | "mongoose"
  | "sequelize"
  | "typeorm"
  | "wordpress"
  | "contentful"
  | "sanity"
  | "strapi"
  | "ghost"
  | "prismic"
  | "dato-cms"
  | "payload"
  | "firebase"
  | "supabase"
  | "planetscale"
  | "neon"
  | "clerk"
  | "next-auth"
  | "passport"
  | "redis"
  | "upstash"
  | "s3"
  | "cloudinary"
  | "uploadthing"
  | "stripe"
  | "shopify"
  | "lemon-squeezy"
  | "resend"
  | "sendgrid"
  | "postmark"
  | "openai"
  | "anthropic"
  | "replicate"
  | "unknown";

export interface DiscoveredDataSource {
  id: string;
  kind: DataSourceKind;
  provider: DataSourceProvider;
  confidence: number;
  detectedFrom: string[];
  configFiles: string[];
  envVarsReferenced: string[];
  usedInRouteIds: string[];
  usedInFiles: string[];
  schemaFiles: string[];
}

// ─── Relationships ────────────────────────────────────────────────────────────

export type RelationshipKind =
  | "route-uses-component"
  | "route-uses-layout"
  | "layout-wraps-route"
  | "component-imports-component"
  | "route-calls-api"
  | "route-uses-datasource"
  | "api-uses-datasource"
  | "component-uses-datasource"
  | "route-links-route"
  | "route-redirects-route";

export type NodeKind = "route" | "layout" | "component" | "api" | "datasource";

export interface DiscoveredRelationship {
  id: string;
  kind: RelationshipKind;
  fromId: string;
  fromType: NodeKind;
  toId: string;
  toType: NodeKind;
  confidence: number;
  filePath: string;
}

// ─── Orphans & Duplicates ─────────────────────────────────────────────────────

export type DuplicateReason = "exact-path" | "param-collision" | "wildcard-overlap";

export interface DuplicateRoute {
  path: string;
  routeIds: string[];
  reason: DuplicateReason;
}

// ─── Root Output ──────────────────────────────────────────────────────────────

export interface DiscoveryStats {
  totalFiles: number;
  routeCount: number;
  layoutCount: number;
  componentCount: number;
  apiCount: number;
  dataSourceCount: number;
  relationshipCount: number;
  orphanCount: number;
  duplicateCount: number;
  analysisTimeMs: number;
}

export interface DiscoverySiteGraph {
  version: "1.0";
  generatedAt: string;
  stats: DiscoveryStats;
  framework: FrameworkDetectionResult;
  routes: DiscoveredRoute[];
  layouts: DiscoveredLayout[];
  components: DiscoveredComponent[];
  apis: DiscoveredApiEndpoint[];
  dataSources: DiscoveredDataSource[];
  relationships: DiscoveredRelationship[];
  orphanPages: string[];
  duplicateRoutes: DuplicateRoute[];
}

// ─── Input ────────────────────────────────────────────────────────────────────

export type VirtualFileSystem = Record<string, string>;

export interface SiteDiscoveryOptions {
  rootPath?: string;
  maxDepth?: number;
  includeNodeModules?: boolean;
  includeDotFiles?: boolean;
}
