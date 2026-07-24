import type {
  BackendProfile,
  DatabaseSchema,
  AuthProfile,
  StorageProfile,
} from "./types.js";

/**
 * detectBackendProfile — auto-detect a BackendProfile from the current
 * Replit environment (env vars, well-known signals).
 *
 * Callers can merge / override fields after detection.
 */
export function detectBackendProfile(): BackendProfile {
  const analyzedAt = new Date().toISOString();
  const framework  = detectFramework();
  const databaseSchema = detectDatabaseSchema();
  const authentication = detectAuth();
  const storage        = detectStorage();

  return {
    version: "1.0",
    analyzedAt,
    framework,
    routes: [],
    apis:   [],
    databaseSchema,
    authentication,
    cms:     null,
    storage,
    metadata: {
      totalRoutes: 0,
      totalApis:   0,
      totalTables: databaseSchema.tables.length,
      hasAuth:     authentication.strategy !== "none" && authentication.strategy !== "unknown",
      hasCms:      false,
      hasStorage:  storage !== null && storage.provider !== "none",
    },
  };
}

function detectFramework(): string {
  if (process.env["NEXT_PUBLIC_URL"])   return "nextjs";
  if (process.env["ASTRO_PORT"])        return "astro";
  if (process.env["LARAVEL_APP_KEY"])   return "laravel";
  return "express";
}

function detectDatabaseSchema(): DatabaseSchema {
  const url       = process.env["DATABASE_URL"] ?? "";
  const isMongo   = url.startsWith("mongodb");
  const hasDb     = url.length > 0;
  return {
    dialect:       isMongo ? "mongodb" : hasDb ? "postgres" : "unknown",
    orm:           hasDb && !isMongo ? "drizzle" : "unknown",
    tables:        [],
    hasMigrations: hasDb && !isMongo,
  };
}

function detectAuth(): AuthProfile {
  const hasSession = !!process.env["SESSION_SECRET"];
  const hasClerk   = !!process.env["CLERK_SECRET_KEY"];
  const hasJwt     = !!process.env["JWT_SECRET"];
  const strategy   = hasClerk ? "oauth" : hasJwt ? "jwt" : hasSession ? "session" : "unknown";
  return {
    strategy,
    provider:         hasClerk ? "clerk" : undefined,
    protectedRoutes:  [],
    hasRoles:         false,
    hasPermissions:   false,
    sessionStore:     hasSession ? "cookie" : undefined,
  };
}

function detectStorage(): StorageProfile | null {
  const hasR2 = !!process.env["R2_ACCESS_KEY_ID"];
  const hasS3 = !!process.env["AWS_ACCESS_KEY_ID"];
  if (hasR2) {
    return {
      provider:         "r2",
      bucket:           process.env["R2_BUCKET_NAME"],
      publicBaseUrl:    process.env["R2_PUBLIC_BASE_URL"],
      hasUploadEndpoint: true,
      maxFileSizeMb:    100,
    };
  }
  if (hasS3) {
    return {
      provider:         "s3",
      bucket:           process.env["AWS_S3_BUCKET"],
      hasUploadEndpoint: true,
    };
  }
  return null;
}
