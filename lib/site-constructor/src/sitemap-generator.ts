import type { AssemblyPage } from "@workspace/stencil-assembly-engine";
import type { PortableManifest } from "@workspace/site-intelligence";
import type { SitemapEntry, SearchIndexEntry, SiteFile } from "./types.js";
import { escapeHtml } from "./nav-generator.js";

// ---------------------------------------------------------------------------
// generateSitemap
// Produces sitemap.xml from the assembled pages.
// ---------------------------------------------------------------------------

export function generateSitemap(
  pages: AssemblyPage[],
  seedUrl: string
): { entries: SitemapEntry[]; file: SiteFile } {
  const base = seedUrl.replace(/\/$/, "");

  const entries: SitemapEntry[] = pages
    .filter((p) => !p.meta.noIndex)
    .map((page) => ({
      route: page.route,
      url: `${base}${page.route === "/" ? "" : page.route}`,
      priority: page.priority,
      changeFreq: page.changeFreq,
      lastMod: new Date().toISOString().split("T")[0]!,
    }));

  const urlsXml = entries
    .map(
      (e) => `  <url>
    <loc>${escapeHtml(e.url)}</loc>
    <lastmod>${e.lastMod}</lastmod>
    <changefreq>${e.changeFreq}</changefreq>
    <priority>${e.priority.toFixed(1)}</priority>
  </url>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlsXml}
</urlset>`;

  return {
    entries,
    file: {
      path: "sitemap.xml",
      content: xml,
      encoding: "utf-8",
      sizeBytes: Buffer.byteLength(xml, "utf8"),
      fileType: "xml",
      pageId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// generateSearchIndex
// Produces a search-index.json with searchable content for every page.
// ---------------------------------------------------------------------------

export function generateSearchIndex(
  pages: AssemblyPage[],
  manifest: PortableManifest
): { index: SearchIndexEntry[]; file: SiteFile } {
  const nodeMap = new Map(manifest.nodes.map((n) => [n.id, n]));

  const index: SearchIndexEntry[] = pages
    .filter((p) => !p.meta.noIndex && p.sourceNodeId !== null)
    .map((page) => {
      const node = page.sourceNodeId ? nodeMap.get(page.sourceNodeId) : null;
      const textContent = node?.content.textContent ?? "";
      const excerpt = textContent.slice(0, 200).trim().replace(/\s+/g, " ");

      return {
        id: page.id,
        title: page.title,
        url: page.meta.canonicalUrl ?? page.route,
        route: page.route,
        excerpt: excerpt || (page.meta.description ?? ""),
        contentType: page.contentType,
        publishedAt: page.meta.publishedAt,
        wordCount: node?.content.wordCount ?? page.estimatedWordCount ?? 0,
        tags: [],
      };
    });

  const json = JSON.stringify(index, null, 2);

  return {
    index,
    file: {
      path: "search-index.json",
      content: json,
      encoding: "utf-8",
      sizeBytes: Buffer.byteLength(json, "utf8"),
      fileType: "json",
      pageId: null,
    },
  };
}
