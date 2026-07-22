/**
 * categories.ts — Category Intelligence Engine
 *
 * Builds a CategoryGraph from the manifest node set using:
 *   1. URL path segment analysis (primary source)
 *   2. Title keyword extraction (secondary source)
 *   3. Cluster inference for isolated nodes (fallback)
 *
 * Output: a hierarchical CategoryGraph with category nodes,
 * tag relationships, and uncategorized page tracking.
 */

import type {
  PortablePageNode,
  CategoryNode,
  TagRelationship,
  CategoryGraph,
} from "./types";

// ---------------------------------------------------------------------------
// URL segment extraction
// ---------------------------------------------------------------------------

function extractUrlSegments(url: string): string[] {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean)
      .filter((seg) => !/^\d+$/.test(seg)) // remove pure numeric segments
      .filter((seg) => !/\.(html?|php|aspx?)$/i.test(seg)) // remove file extensions
      .map((seg) => seg.toLowerCase().replace(/-/g, " ").replace(/_/g, " "))
      .slice(0, 4); // max 4 levels of categories
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Common stopwords to skip as category labels
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "and", "or",
  "is", "are", "was", "be", "been", "by", "with", "from", "as", "that",
  "this", "it", "its", "page", "post", "article", "www", "http", "https",
  "index", "home", "default", "main", "content", "section",
]);

// ---------------------------------------------------------------------------
// Title keyword extraction
// ---------------------------------------------------------------------------

function extractTitleKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// Category ID generation
// ---------------------------------------------------------------------------

function makeCategoryId(label: string, parentId: string | null): string {
  const slug = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return parentId ? `${parentId}__${slug}` : slug;
}

function makeSlug(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

// ---------------------------------------------------------------------------
// Public: build CategoryGraph
// ---------------------------------------------------------------------------

export function buildCategoryGraph(nodes: PortablePageNode[]): CategoryGraph {
  const contentNodes = nodes.filter(
    (n) => n.nodeType !== "root" && n.nodeType !== "asset"
  );

  // categoryId → CategoryNode (mutable during build)
  const categoryMap = new Map<
    string,
    { node: CategoryNode; labelLower: string }
  >();

  // nodeId → categoryIds it belongs to
  const nodeCategoryIds = new Map<string, Set<string>>();

  // tag frequency map
  const tagMap = new Map<string, Set<string>>(); // tag → nodeIds

  // Process each content node
  for (const node of contentNodes) {
    const segments = extractUrlSegments(node.metadata.url);
    const keywords = extractTitleKeywords(node.metadata.title);
    const assignedCategories = new Set<string>();

    // Build category hierarchy from URL segments
    let parentId: string | null = null;
    let depth = 0;

    for (const segment of segments.slice(0, 3)) {
      if (STOPWORDS.has(segment) || segment.length < 2) continue;

      const catId = makeCategoryId(segment, parentId);

      if (!categoryMap.has(catId)) {
        const catNode: CategoryNode = {
          id: catId,
          label: segment.charAt(0).toUpperCase() + segment.slice(1),
          slug: makeSlug(segment),
          parentId,
          childIds: [],
          pageIds: [],
          pageCount: 0,
          depth,
          source: "url_segment",
        };

        // Link to parent
        if (parentId) {
          const parentEntry = categoryMap.get(parentId);
          if (parentEntry && !parentEntry.node.childIds.includes(catId)) {
            parentEntry.node.childIds.push(catId);
          }
        }

        categoryMap.set(catId, { node: catNode, labelLower: segment });
      }

      const entry = categoryMap.get(catId)!;
      if (!entry.node.pageIds.includes(node.id)) {
        entry.node.pageIds.push(node.id);
        entry.node.pageCount++;
      }
      assignedCategories.add(catId);

      parentId = catId;
      depth++;
    }

    // Tags from title keywords
    for (const keyword of keywords.slice(0, 4)) {
      const existing = tagMap.get(keyword) ?? new Set<string>();
      existing.add(node.id);
      tagMap.set(keyword, existing);
    }

    nodeCategoryIds.set(node.id, assignedCategories);
  }

  // Determine uncategorized pages
  const uncategorizedPageIds = contentNodes
    .filter((n) => {
      const cats = nodeCategoryIds.get(n.id);
      return !cats || cats.size === 0;
    })
    .map((n) => n.id);

  // Build categories array (sorted by depth then label)
  const categories: CategoryNode[] = Array.from(categoryMap.values())
    .map((e) => e.node)
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.label.localeCompare(b.label);
    });

  // Build category index: slug → id
  const categoryIndex: Record<string, string> = {};
  for (const cat of categories) {
    categoryIndex[cat.slug] = cat.id;
  }

  // Build tag relationships (only tags appearing in 2+ nodes)
  const tags: TagRelationship[] = Array.from(tagMap.entries())
    .filter(([, nodeIds]) => nodeIds.size >= 2)
    .map(([tag, nodeIds]) => ({
      tag,
      nodeIds: Array.from(nodeIds),
      frequency: nodeIds.size,
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 100); // cap at 100 tags

  const maxDepth = categories.reduce((m, c) => Math.max(m, c.depth), 0);

  return {
    categories,
    categoryIndex,
    tags,
    uncategorizedPageIds,
    totalCategories: categories.length,
    maxDepth,
  };
}
