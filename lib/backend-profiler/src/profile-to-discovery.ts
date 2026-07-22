import type { BackendProfile } from "./types.js";
import type {
  DiscoverySiteGraph,
  DiscoveredRoute,
  DiscoveredApiEndpoint,
  DiscoveredDataSource,
  Framework,
  RouteMethod,
  DataSourceProvider,
} from "@workspace/site-discovery";

/**
 * profileToDiscoverySiteGraph — converts a BackendProfile into a
 * DiscoverySiteGraph so it can be fed into compileMergePlan().
 */
export function profileToDiscoverySiteGraph(profile: BackendProfile): DiscoverySiteGraph {
  const framework = normalizeFramework(profile.framework);

  const routes: DiscoveredRoute[] = profile.routes.map((r, i) => ({
    id:            `bp-route-${i}`,
    path:          r.path,
    filePath:      `src/routes${r.path}.ts`,
    routeType:     "page" as const,
    pageType:      r.isDynamic ? ("dynamic" as const) : ("static" as const),
    methods:       r.methods as RouteMethod[],
    isDynamic:     r.isDynamic,
    params:        r.params,
    layoutId:      null,
    parentRouteId: null,
    childRouteIds: [],
    isOrphan:      false,
    duplicateOf:   null,
    framework,
    depth:         r.path.split("/").filter(Boolean).length,
  }));

  const apis: DiscoveredApiEndpoint[] = profile.apis.map((a, i) => ({
    id:            `bp-api-${i}`,
    path:          a.path,
    methods:       a.methods as RouteMethod[],
    filePath:      `src/api${a.path}.ts`,
    framework,
    isAuth:        a.isAuthenticated,
    hasValidation: a.hasValidation,
    returnsJson:   true,
    paramNames:    [],
    queryParams:   [],
    handlerName:   null,
  }));

  const dataSources: DiscoveredDataSource[] = [];

  // Map DB dialect/ORM to a known DataSourceProvider
  if (profile.databaseSchema.dialect !== "unknown") {
    const dbProvider = resolveDbProvider(profile.databaseSchema.orm, profile.databaseSchema.dialect);
    for (const table of profile.databaseSchema.tables) {
      dataSources.push({
        id:                `bp-ds-db-${table.name}`,
        kind:              "database",
        provider:          dbProvider,
        confidence:        1.0,
        detectedFrom:      ["BackendProfile"],
        configFiles:       [],
        envVarsReferenced: ["DATABASE_URL"],
        usedInRouteIds:    [],
        usedInFiles:       [],
        schemaFiles:       [],
      });
    }
    // At minimum add one DB datasource even if no tables declared
    if (profile.databaseSchema.tables.length === 0) {
      dataSources.push({
        id:                "bp-ds-db",
        kind:              "database",
        provider:          dbProvider,
        confidence:        0.9,
        detectedFrom:      ["BackendProfile", "environment"],
        configFiles:       [],
        envVarsReferenced: ["DATABASE_URL"],
        usedInRouteIds:    [],
        usedInFiles:       [],
        schemaFiles:       [],
      });
    }
  }

  // Auth datasource
  if (profile.authentication.strategy !== "none" && profile.authentication.strategy !== "unknown") {
    const authProvider: DataSourceProvider =
      profile.authentication.provider === "clerk" ? "clerk" : "passport";
    dataSources.push({
      id:                "bp-ds-auth",
      kind:              "auth",
      provider:          authProvider,
      confidence:        1.0,
      detectedFrom:      ["BackendProfile"],
      configFiles:       [],
      envVarsReferenced: ["SESSION_SECRET", "CLERK_SECRET_KEY"],
      usedInRouteIds:    [],
      usedInFiles:       [],
      schemaFiles:       [],
    });
  }

  // CMS datasource
  if (profile.cms) {
    const cmsProvider = normalizeCmsProvider(profile.cms.provider);
    dataSources.push({
      id:                "bp-ds-cms",
      kind:              "cms",
      provider:          cmsProvider,
      confidence:        0.9,
      detectedFrom:      ["BackendProfile"],
      configFiles:       [],
      envVarsReferenced: [],
      usedInRouteIds:    [],
      usedInFiles:       [],
      schemaFiles:       [],
    });
  }

  const routeCount = routes.length;
  const apiCount   = apis.length;

  return {
    version:     "1.0",
    generatedAt: new Date().toISOString(),
    stats: {
      totalFiles:        routeCount + apiCount,
      routeCount,
      layoutCount:       0,
      componentCount:    0,
      apiCount,
      dataSourceCount:   dataSources.length,
      relationshipCount: 0,
      orphanCount:       0,
      duplicateCount:    0,
      analysisTimeMs:    0,
    },
    framework: {
      primary:        framework,
      secondary:      [],
      confidence:     0.8,
      version:        null,
      features:       [],
      isMonorepo:     true,
      packageManager: "pnpm",
    },
    routes,
    layouts:         [],
    components:      [],
    apis,
    dataSources,
    relationships:   [],
    orphanPages:     [],
    duplicateRoutes: [],
  };
}

function normalizeFramework(fw: string): Framework {
  const map: Record<string, Framework> = {
    nextjs:    "nextjs",
    react:     "react",
    astro:     "astro",
    express:   "express",
    laravel:   "laravel",
    wordpress: "wordpress",
  };
  return map[fw.toLowerCase()] ?? "express";
}

function resolveDbProvider(orm: string, dialect: string): DataSourceProvider {
  if (orm === "drizzle")    return "drizzle";
  if (orm === "prisma")     return "prisma";
  if (orm === "mongoose")   return "mongoose";
  if (orm === "sequelize")  return "sequelize";
  if (dialect === "mongodb") return "mongoose";
  return "drizzle";
}

function normalizeCmsProvider(provider?: string): DataSourceProvider {
  const map: Record<string, DataSourceProvider> = {
    contentful: "contentful",
    sanity:     "sanity",
    strapi:     "strapi",
    ghost:      "ghost",
    prismic:    "prismic",
    wordpress:  "wordpress",
    payload:    "payload",
  };
  return (provider && map[provider]) ? map[provider] : "strapi";
}
