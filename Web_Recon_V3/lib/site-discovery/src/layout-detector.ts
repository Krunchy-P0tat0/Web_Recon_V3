import type {
  DiscoveredLayout,
  DiscoveredRoute,
  Framework,
  FrameworkDetectionResult,
  VirtualFileSystem,
} from "./types.js";

let layoutSeq = 0;
function nextId(): string {
  return `layout-${(++layoutSeq).toString().padStart(4, "0")}`;
}

// ─── Content heuristics ───────────────────────────────────────────────────────

function hasChildren(content: string): boolean {
  return content.includes("{children}") || content.includes("{ children }");
}

function detectSlots(content: string): { header: boolean; footer: boolean; nav: boolean; sidebar: boolean } {
  const lower = content.toLowerCase();
  return {
    header: lower.includes("<header") || lower.includes("header>") || /header\b/.test(lower),
    footer: lower.includes("<footer") || lower.includes("footer>") || /footer\b/.test(lower),
    nav: lower.includes("<nav") || lower.includes("navbar") || lower.includes("navigation"),
    sidebar: lower.includes("sidebar") || lower.includes("aside") || lower.includes("<aside"),
  };
}

function extractImportedComponents(content: string): string[] {
  const comps: string[] = [];
  const imports = content.matchAll(/import\s+\{?\s*([A-Z][A-Za-z0-9]+)\s*\}?\s+from/g);
  for (const m of imports) {
    comps.push(m[1]!);
  }
  return comps;
}

function layoutName(filePath: string): string {
  const parts = filePath.split("/");
  const file = parts[parts.length - 1]!.replace(/\.[^.]+$/, "");
  if (file.toLowerCase() === "layout") {
    const dir = parts[parts.length - 2] ?? "Root";
    return `${dir.charAt(0).toUpperCase() + dir.slice(1)}Layout`;
  }
  return file.charAt(0).toUpperCase() + file.slice(1);
}

function nestingLevel(filePath: string): number {
  const m = filePath.match(/(?:^|\/)app\/(.+)\/layout\./);
  if (!m) return 0;
  return m[1]!.split("/").filter((s) => !/^\(.*\)$/.test(s)).length;
}

function isNextAppRouterLayoutFile(filePath: string): boolean {
  return /(?:^|\/)app\/.*layout\.[tj]sx?$/.test(filePath);
}

// ─── Next.js App Router layouts ───────────────────────────────────────────────

function detectNextLayouts(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  framework: Framework
): DiscoveredLayout[] {
  const layouts: DiscoveredLayout[] = [];

  for (const [filePath, content] of Object.entries(vfs)) {
    if (!/\/app\/.*layout\.[tj]sx?$/.test(filePath) && !/^app\/.*layout\.[tj]sx?$/.test(filePath)) continue;
    if (!hasChildren(content)) continue;

    const slots = detectSlots(content);
    const level = nestingLevel(filePath);

    const layoutPathPrefix = filePath
      .replace(/layout\.[tj]sx?$/, "")
      .replace(/\(.*?\)\//g, "");

    const wrapsRouteIds = routes
      .filter((r) => {
        const routeFile = r.filePath;
        return routeFile.startsWith(layoutPathPrefix) && routeFile !== filePath;
      })
      .map((r) => r.id);

    const components = extractImportedComponents(content);

    layouts.push({
      id: nextId(),
      name: layoutName(filePath),
      filePath,
      framework,
      wrapsRouteIds,
      components,
      hasHeader: slots.header,
      hasFooter: slots.footer,
      hasNav: slots.nav,
      hasSidebar: slots.sidebar,
      nestingLevel: level,
    });
  }

  return layouts;
}

// ─── Named layout files ───────────────────────────────────────────────────────

function detectNamedLayouts(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  framework: Framework
): DiscoveredLayout[] {
  const layouts: DiscoveredLayout[] = [];

  for (const [filePath, content] of Object.entries(vfs)) {
    if (isNextAppRouterLayoutFile(filePath)) continue;
    if (!/layout/i.test(filePath)) continue;
    if (!/\.(tsx?|jsx?|astro)$/.test(filePath)) continue;

    const hasExport = content.includes("export default") || content.includes("export function");
    if (!hasExport) continue;
    if (!hasChildren(content) && !content.includes("Outlet") && !content.includes("slot")) continue;

    const slots = detectSlots(content);
    const components = extractImportedComponents(content);

    layouts.push({
      id: nextId(),
      name: layoutName(filePath),
      filePath,
      framework,
      wrapsRouteIds: [],
      components,
      hasHeader: slots.header,
      hasFooter: slots.footer,
      hasNav: slots.nav,
      hasSidebar: slots.sidebar,
      nestingLevel: 0,
    });
  }

  return layouts;
}

// ─── WordPress templates ──────────────────────────────────────────────────────

function detectWordPressLayouts(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  _framework: Framework
): DiscoveredLayout[] {
  const layouts: DiscoveredLayout[] = [];

  const headerFile = Object.keys(vfs).find((f) => /header\.php$/.test(f));
  const footerFile = Object.keys(vfs).find((f) => /footer\.php$/.test(f));

  if (headerFile || footerFile) {
    layouts.push({
      id: nextId(),
      name: "WordPressThemeLayout",
      filePath: "functions.php",
      framework: "wordpress",
      wrapsRouteIds: routes.map((r) => r.id),
      components: [headerFile, footerFile].filter(Boolean) as string[],
      hasHeader: !!headerFile,
      hasFooter: !!footerFile,
      hasNav: !!Object.keys(vfs).find((f) => /navigation|menu/.test(f)),
      hasSidebar: !!Object.keys(vfs).find((f) => /sidebar/.test(f)),
      nestingLevel: 0,
    });
  }

  return layouts;
}

// ─── Laravel Blade ────────────────────────────────────────────────────────────

function detectLaravelLayouts(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  _framework: Framework
): DiscoveredLayout[] {
  const layouts: DiscoveredLayout[] = [];

  for (const [filePath, content] of Object.entries(vfs)) {
    if (!filePath.includes("resources/views") || !filePath.endsWith(".blade.php")) continue;
    if (!content.includes("@yield") && !content.includes("@section") && !content.includes("{{ $slot }}")) continue;

    const slots = detectSlots(content);
    layouts.push({
      id: nextId(),
      name: layoutName(filePath),
      filePath,
      framework: "laravel",
      wrapsRouteIds: routes.map((r) => r.id),
      components: [],
      hasHeader: slots.header,
      hasFooter: slots.footer,
      hasNav: slots.nav,
      hasSidebar: slots.sidebar,
      nestingLevel: 0,
    });
  }

  return layouts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectLayouts(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  fw: FrameworkDetectionResult
): DiscoveredLayout[] {
  layoutSeq = 0;
  const layouts: DiscoveredLayout[] = [];

  if (fw.primary === "nextjs") {
    layouts.push(...detectNextLayouts(vfs, routes, fw.primary));
    layouts.push(...detectNamedLayouts(vfs, routes, fw.primary));
  } else if (fw.primary === "astro") {
    layouts.push(...detectNamedLayouts(vfs, routes, fw.primary));
  } else if (fw.primary === "wordpress") {
    layouts.push(...detectWordPressLayouts(vfs, routes, fw.primary));
  } else if (fw.primary === "laravel") {
    layouts.push(...detectLaravelLayouts(vfs, routes, fw.primary));
  } else {
    layouts.push(...detectNamedLayouts(vfs, routes, fw.primary));
  }

  for (const route of routes) {
    const matchingLayout = layouts.find((l) => l.wrapsRouteIds.includes(route.id));
    if (matchingLayout) route.layoutId = matchingLayout.id;
  }

  return layouts;
}
