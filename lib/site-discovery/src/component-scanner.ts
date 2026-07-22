import type {
  ComponentProp,
  ComponentType,
  DiscoveredComponent,
  VirtualFileSystem,
} from "./types.js";

let compSeq = 0;
function nextId(): string {
  return `comp-${(++compSeq).toString().padStart(4, "0")}`;
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

const NEXT_APP_ROUTER_SPECIALS = /(?:^|\/)app\/(?:.+\/)?(?:page|layout|loading|error|not-found|template|default|route)\.[tj]sx?$/;

function isComponentFile(filePath: string): boolean {
  if (!/\.(tsx|jsx|astro)$/.test(filePath)) return false;
  const lower = filePath.toLowerCase();
  if (lower.includes("node_modules")) return false;
  if (lower.includes(".test.") || lower.includes(".spec.") || lower.includes(".stories.")) return false;
  if (NEXT_APP_ROUTER_SPECIALS.test(filePath)) return false;
  return true;
}

function isReusableDir(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("/components/") ||
    lower.includes("/ui/") ||
    lower.includes("/shared/") ||
    lower.includes("/common/") ||
    lower.includes("/widgets/") ||
    lower.includes("/blocks/") ||
    lower.includes("/elements/") ||
    lower.includes("/atoms/") ||
    lower.includes("/molecules/") ||
    lower.includes("/organisms/") ||
    lower.includes("/templates/")
  );
}

function extractComponentName(filePath: string): string | null {
  const m = filePath.match(/([A-Z][A-Za-z0-9]+)(?:\.[tj]sx?|\.astro)$/);
  if (m) return m[1]!;
  const lower = filePath.match(/([a-z][a-z0-9-]+)(?:\.[tj]sx?|\.astro)$/)
  if (lower) {
    return lower[1]!
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("");
  }
  return null;
}

function classifyComponent(name: string, filePath: string, content: string): ComponentType {
  const lower = name.toLowerCase();
  const pathLower = filePath.toLowerCase();

  if (/layout|wrapper|shell|frame|scaffold/.test(lower)) return "layout";
  if (/page$|^page/.test(lower)) return "page";
  if (/nav|menu|header|footer|sidebar|breadcrumb|drawer/.test(lower)) return "navigation";
  if (/form|input|select|checkbox|radio|textarea|field|control/.test(lower)) return "form";
  if (/table|list|grid|card|gallery|feed|timeline|chart|graph|stat/.test(lower)) return "data-display";
  if (/modal|dialog|toast|alert|spinner|loader|skeleton|tooltip|badge/.test(lower)) return "feedback";
  if (/image|img|video|audio|carousel|slider|lightbox|avatar/.test(lower)) return "media";
  if (/button|btn|icon|badge|tag|chip|divider|separator/.test(lower)) return "ui";
  if (/hook|util|helper|provider|context|store|hoc/.test(lower)) return "utility";

  if (pathLower.includes("/layout")) return "layout";
  if (pathLower.includes("/nav") || pathLower.includes("/menu")) return "navigation";
  if (content.includes("children") && content.includes("return")) return "layout";

  return "unknown";
}

const PROP_RE = /(\w+)(\?)?:\s*([^;,\n}]+)/g;

function extractProps(content: string, componentName: string): ComponentProp[] {
  const props: ComponentProp[] = [];
  const interfaces = [
    new RegExp(`interface\\s+${componentName}Props\\s*\\{([^}]+)\\}`, "s"),
    new RegExp(`type\\s+${componentName}Props\\s*=\\s*\\{([^}]+)\\}`, "s"),
    /interface\s+Props\s*\{([^}]+)\}/s,
    /type\s+Props\s*=\s*\{([^}]+)\}/s,
  ];

  for (const re of interfaces) {
    const m = content.match(re);
    if (!m) continue;
    const body = m[1]!;
    PROP_RE.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = PROP_RE.exec(body)) !== null) {
      const name = pm[1]!;
      if (name === "children" || name === "className" || name === "style") continue;
      props.push({
        name,
        type: pm[3]!.trim(),
        required: pm[2] !== "?",
        hasDefault: content.includes(`${name} =`) || content.includes(`${name}:`),
      });
    }
    break;
  }

  return props;
}

// ─── Usage tracking ───────────────────────────────────────────────────────────

function buildUsageMap(vfs: VirtualFileSystem): Map<string, string[]> {
  const usage = new Map<string, string[]>();

  for (const [filePath, content] of Object.entries(vfs)) {
    if (!/\.(tsx|jsx|ts|js|astro)$/.test(filePath)) continue;
    const imports = content.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g);
    for (const imp of imports) {
      const target = imp[1]!;
      if (!target.startsWith(".") && !target.startsWith("@/")) continue;
      if (!usage.has(target)) usage.set(target, []);
      usage.get(target)!.push(filePath);
    }
  }

  return usage;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function scanComponents(vfs: VirtualFileSystem): DiscoveredComponent[] {
  compSeq = 0;
  const usageMap = buildUsageMap(vfs);
  const components: DiscoveredComponent[] = [];

  for (const [filePath, content] of Object.entries(vfs)) {
    if (!isComponentFile(filePath)) continue;

    const name = extractComponentName(filePath);
    if (!name) continue;

    const hasDefault =
      content.includes("export default function") ||
      content.includes("export default class") ||
      content.includes("export default (") ||
      content.includes("export default React.memo") ||
      /const \w+ = .+;\s*export default \w+/.test(content);

    const hasNamed =
      content.includes("export function") ||
      content.includes("export const") ||
      content.includes("export class");

    if (!hasDefault && !hasNamed) continue;

    const isClientComponent = content.trimStart().startsWith('"use client"') ||
      content.trimStart().startsWith("'use client'") ||
      content.includes('"use client"') ||
      content.includes("'use client'");
    const isServerComponent = content.trimStart().startsWith('"use server"') ||
      content.trimStart().startsWith("'use server'") ||
      content.includes('"use server"');

    const usedInFiles = usageMap.get(
      filePath.replace(/\.[tj]sx?$/, "").replace(/\/index$/, "")
    ) ?? [];

    const isReusable = isReusableDir(filePath) || usedInFiles.length >= 2;
    const componentType = classifyComponent(name, filePath, content);
    const props = extractProps(content, name);

    components.push({
      id: nextId(),
      name,
      filePath,
      isReusable,
      usedInFiles,
      usedInRouteIds: [],
      props,
      hasDefaultExport: hasDefault,
      hasNamedExport: hasNamed,
      componentType,
      isClientComponent,
      isServerComponent,
    });
  }

  return components;
}
