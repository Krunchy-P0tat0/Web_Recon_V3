/**
 * route-resolver.ts — Fills dynamic :param segments in route patterns
 *
 * Given a route pattern like "/posts/:slug" and a page node, produces
 * a resolved path like "/posts/my-article-title".
 *
 * Resolution strategy (deterministic):
 *   :slug       → last non-numeric path segment of the URL, or title-slugified
 *   :year       → publishedAt year, or extracted from URL
 *   :month      → publishedAt month (zero-padded), or from URL
 *   :section    → first path segment (category slug)
 *   :id         → node id (truncated to 8 chars)
 *   :tag        → first tag keyword from title
 *   :page       → "1" (first page, deterministic)
 */

// ── Slug utilities ────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function extractPathSegments(url: string): string[] {
  try {
    return new URL(url).pathname
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean)
      .filter((s: string) => !/\.(html?|php|aspx?)$/i.test(s));
  } catch {
    return [];
  }
}

function extractSlugFromUrl(url: string): string {
  const segments = extractPathSegments(url);
  // Walk from end: skip pure-numeric segments, pick first meaningful one
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (!/^\d+$/.test(seg) && seg.length > 1) {
      return seg.toLowerCase();
    }
  }
  return "page";
}

function extractSectionFromUrl(url: string): string {
  const segments = extractPathSegments(url);
  // First path segment = top-level section
  if (segments.length > 0) return segments[0]!.toLowerCase();
  return "general";
}

function extractYearMonth(
  url: string,
  publishedAt: string | null
): { year: string; month: string } {
  // Try publishedAt first
  if (publishedAt) {
    const d = new Date(publishedAt);
    if (!isNaN(d.getTime())) {
      return {
        year: String(d.getFullYear()),
        month: String(d.getMonth() + 1).padStart(2, "0"),
      };
    }
  }

  // Try extracting YYYY/MM from URL
  const dateMatch = url.match(/\/(\d{4})\/(\d{2})\//);
  if (dateMatch) {
    return { year: dateMatch[1]!, month: dateMatch[2]! };
  }

  // Fallback: use current year/month (deterministic for a given runtime)
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, "0"),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface NodeResolutionInput {
  url: string;
  title: string;
  publishedAt: string | null;
  nodeId: string;
}

/**
 * resolvePath — fills all :param tokens in a route pattern
 * using deterministic rules applied to the node's attributes.
 */
export function resolvePath(
  pattern: string,
  node: NodeResolutionInput
): string {
  let resolved = pattern;

  // :slug — most common dynamic segment
  if (resolved.includes(":slug")) {
    const slug = extractSlugFromUrl(node.url) || slugify(node.title) || node.nodeId.slice(0, 8);
    resolved = resolved.replace(/:slug/g, slug);
  }

  // :year / :month
  if (resolved.includes(":year") || resolved.includes(":month")) {
    const { year, month } = extractYearMonth(node.url, node.publishedAt);
    resolved = resolved.replace(/:year/g, year);
    resolved = resolved.replace(/:month/g, month);
  }

  // :section
  if (resolved.includes(":section")) {
    const section = extractSectionFromUrl(node.url) || "general";
    resolved = resolved.replace(/:section/g, section);
  }

  // :id
  if (resolved.includes(":id")) {
    resolved = resolved.replace(/:id/g, node.nodeId.slice(0, 8));
  }

  // :tag
  if (resolved.includes(":tag")) {
    const tag = slugify(node.title.split(" ")[0] ?? "tag");
    resolved = resolved.replace(/:tag/g, tag);
  }

  // :page (pagination always resolves to first page)
  if (resolved.includes(":page")) {
    resolved = resolved.replace(/:page/g, "1");
  }

  // Any remaining :param → slugify from title
  resolved = resolved.replace(/:([a-z]+)/g, (_match, param) => {
    return slugify(param);
  });

  return resolved;
}

/**
 * resolveCategoryPath — fills :slug for a category route.
 */
export function resolveCategoryPath(
  pattern: string,
  categorySlug: string,
  sectionSlug?: string
): string {
  let resolved = pattern;
  resolved = resolved.replace(/:slug/g, categorySlug);
  resolved = resolved.replace(/:section/g, sectionSlug ?? categorySlug);
  resolved = resolved.replace(/:page/g, "1");
  return resolved;
}
