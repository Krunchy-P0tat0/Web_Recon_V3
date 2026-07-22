/**
 * router-generator.ts
 *
 * Generates src/router.tsx — a React Router v6 routes config derived from
 * SiteAssembly.routeMap (static + dynamic routes).
 *
 * Rules:
 *   - Static routes → exact path + named page component import
 *   - Dynamic routes → path with :param placeholders
 *   - "/" always maps to HomePage
 *   - "*" (catch-all) always maps to NotFoundPage
 *   - Routes are ordered: static first, dynamic second, catch-all last
 */

import type { SiteAssembly } from "@workspace/stencil-assembly-engine";
import type { PrimeFile, PrimeRouteEntry } from "./types.js";

function pageTypeToComponent(pageType: string): string {
  switch (pageType) {
    case "homepage":    return "HomePage";
    case "article":     return "ArticlePage";
    case "blog":        return "BlogPage";
    case "guide":       return "GuidePage";
    case "docs":        return "DocsPage";
    case "category":    return "CategoryPage";
    case "tag":         return "TagPage";
    case "gallery":     return "GalleryPage";
    case "portfolio":   return "PortfolioPage";
    case "search":      return "SearchPage";
    case "faq":         return "FaqPage";
    case "landing":     return "LandingPage";
    default:
      return `${pageType.charAt(0).toUpperCase() + pageType.slice(1).replace(/-./g, (m) => m[1].toUpperCase())}Page`;
  }
}

export function generateRouter(
  assembly: SiteAssembly,
): { file: PrimeFile; routes: PrimeRouteEntry[] } {
  const routeMap = assembly.routes;

  // Collect all unique page types
  const componentSet = new Map<string, string>(); // componentName → import path
  const routeEntries: PrimeRouteEntry[] = [];

  // Homepage is always first
  componentSet.set("HomePage", "../pages/HomePage");

  // Process static routes
  for (const route of routeMap.static) {
    const comp = pageTypeToComponent(route.pageType as string);
    const importPath = `../pages/${comp}`;
    componentSet.set(comp, importPath);
    routeEntries.push({
      path: route.pattern,
      pageType: route.pageType as string,
      isDynamic: false,
      componentFile: `src/pages/${comp}.tsx`,
    });
  }

  // Process dynamic routes
  for (const route of routeMap.dynamic) {
    const comp = pageTypeToComponent(route.pageType as string);
    const importPath = `../pages/${comp}`;
    componentSet.set(comp, importPath);
    routeEntries.push({
      path: route.pattern,
      pageType: route.pageType as string,
      isDynamic: true,
      componentFile: `src/pages/${comp}.tsx`,
    });
  }

  // Always add NotFoundPage as catch-all
  componentSet.set("NotFoundPage", "../pages/NotFoundPage");

  // Build import statements
  const imports = Array.from(componentSet.entries())
    .map(([comp, path]) => `import ${comp} from '${path}';`)
    .join("\n");

  // Ensure homepage route exists
  const hasRoot = routeEntries.some((r) => r.path === "/");
  if (!hasRoot) {
    routeEntries.unshift({
      path: "/",
      pageType: "homepage",
      isDynamic: false,
      componentFile: "src/pages/HomePage.tsx",
    });
  }

  // Deduplicate routes by path (keep first occurrence)
  const seenPaths = new Set<string>();
  const uniqueRoutes = routeEntries.filter((r) => {
    if (seenPaths.has(r.path)) return false;
    seenPaths.add(r.path);
    return true;
  });

  // Build route objects for the router file
  const routeObjects = uniqueRoutes
    .map((r) => {
      const comp = pageTypeToComponent(r.pageType);
      return `  { path: '${r.path}', element: <${comp} /> },`;
    })
    .join("\n");

  const content = `import React from 'react';
${imports}
import NotFoundPage from '../pages/NotFoundPage';

export interface RouteConfig {
  path: string;
  element: React.ReactElement;
}

/**
 * Website Prime route configuration
 * Generated from SiteAssembly.routeMap (Phase 5.1)
 *
 * Total routes: ${uniqueRoutes.length} static + catch-all
 */
export const routes: RouteConfig[] = [
${routeObjects}
  { path: '*', element: <NotFoundPage /> },
];
`;

  return {
    file: { path: "src/router.tsx", content, kind: "tsx" },
    routes: uniqueRoutes,
  };
}
