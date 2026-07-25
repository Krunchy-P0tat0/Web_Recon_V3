// ─── Phase 5.8 — Backend Merge Intelligence ──────────────────────────────────
// BackendProfile describes the existing application that Website Prime merges into.

export type MergeActionPhase58 = "CREATE" | "UPDATE" | "REUSE" | "SKIP" | "ARCHIVE";
export type MergeRiskScore = "LOW" | "MEDIUM" | "HIGH";

// ─── Route / API ──────────────────────────────────────────────────────────────

export interface BackendRouteEntry {
  path: string;
  methods: string[];
  isDynamic: boolean;
  params: string[];
  handler?: string;
  middleware?: string[];
  isAuthenticated?: boolean;
}

export interface BackendApiEntry {
  path: string;
  methods: string[];
  isAuthenticated: boolean;
  hasValidation: boolean;
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  rateLimit?: string;
}

// ─── Database ─────────────────────────────────────────────────────────────────

export type DbDialect = "postgres" | "mysql" | "sqlite" | "mongodb" | "unknown";
export type DbOrm     = "drizzle" | "prisma" | "sequelize" | "eloquent" | "mongoose" | "none" | "unknown";

export interface DatabaseColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  references?: string;
}

export interface DatabaseTable {
  name: string;
  columns: DatabaseColumn[];
  relations: string[];
  hasTimestamps: boolean;
  hasIndex: boolean;
}

export interface DatabaseSchema {
  dialect: DbDialect;
  orm: DbOrm;
  tables: DatabaseTable[];
  hasMigrations: boolean;
}

// ─── Auth / CMS / Storage ─────────────────────────────────────────────────────

export type AuthStrategy = "jwt" | "session" | "oauth" | "api-key" | "none" | "unknown";

export interface AuthProfile {
  strategy: AuthStrategy;
  provider?: string;
  protectedRoutes: string[];
  hasRoles: boolean;
  hasPermissions: boolean;
  sessionStore?: "memory" | "redis" | "database" | "cookie";
}

export interface CmsProfile {
  type: "headless" | "traditional" | "hybrid" | "custom";
  provider?: string;
  contentTypes: string[];
  hasApi: boolean;
  apiEndpoint?: string;
}

export type StorageProvider = "r2" | "s3" | "gcs" | "azure" | "local" | "none";

export interface StorageProfile {
  provider: StorageProvider;
  bucket?: string;
  publicBaseUrl?: string;
  hasUploadEndpoint: boolean;
  uploadPath?: string;
  maxFileSizeMb?: number;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export interface BackendProfile {
  version: "1.0";
  analyzedAt: string;
  framework: string;
  routes: BackendRouteEntry[];
  apis: BackendApiEntry[];
  databaseSchema: DatabaseSchema;
  authentication: AuthProfile;
  cms: CmsProfile | null;
  storage: StorageProfile | null;
  metadata: {
    totalRoutes: number;
    totalApis: number;
    totalTables: number;
    hasAuth: boolean;
    hasCms: boolean;
    hasStorage: boolean;
  };
}

// ─── Risk ─────────────────────────────────────────────────────────────────────

export interface MergeRiskFactor {
  factor: string;
  impact: "low" | "medium" | "high";
  detail: string;
}

export interface MergeRiskResult {
  mergeRiskScore: MergeRiskScore;
  score: number;
  factors: MergeRiskFactor[];
  blockerCount: number;
  errorCount: number;
  warningCount: number;
}
