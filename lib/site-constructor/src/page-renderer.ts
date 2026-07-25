import type { AssemblyPage, AssemblyNavigation } from "@workspace/stencil-assembly-engine";
import type { DesignSystem } from "@workspace/theme-intelligence";
import type { PortablePageNode } from "@workspace/site-intelligence";
import type { SiteFile, ConstructionIssue } from "./types.js";
import { generateNavHTML, generateFooterHTML, generateBreadcrumbsHTML, escapeHtml } from "./nav-generator.js";
import { remapContentAssets, getHeroImageUrl } from "./asset-mapper.js";
import type { AssetGraph } from "@workspace/site-intelligence";

// ---------------------------------------------------------------------------
// renderPage
// Produces a complete self-contained HTML file for a single AssemblyPage.
// ---------------------------------------------------------------------------

export interface RenderPageOptions {
  page: AssemblyPage;
  node: PortablePageNode | null;
  nav: AssemblyNavigation;
  designSystem: DesignSystem;
  assetGraph: AssetGraph;
  assetMap: Map<string, string>;
  siteTitle: string;
  cssRelPath: string; // relative path to styles.css from this page's directory
}

export interface RenderPageResult {
  file: SiteFile;
  issues: ConstructionIssue[];
}

export function renderPage(opts: RenderPageOptions): RenderPageResult {
  const { page, node, nav, designSystem, assetMap, siteTitle, cssRelPath } = opts;
  const issues: ConstructionIssue[] = [];

  if (!node && !page.isGenerated) {
    issues.push({
      severity: "warning",
      code: "MISSING_CONTENT_NODE",
      message: `Page "${page.route}" has no matching manifest node — rendering metadata-only placeholder`,
      pageId: page.id,
      route: page.route,
    });
  }

  const meta = page.meta;
  const baseUrl = node?.metadata.url ?? meta.canonicalUrl ?? "";

  // Remap assets in content
  const rawHtml = node?.content.cleanHtml ?? "";
  const content = rawHtml ? remapContentAssets(rawHtml, assetMap, baseUrl) : "";

  // Get hero image
  const heroImageUrl = getHeroImageUrl(node, assetMap);

  // Navigation
  const navHtml = generateNavHTML(nav, siteTitle, page.route);
  const footerHtml = generateFooterHTML(nav, siteTitle);

  // Breadcrumbs — build from nav if available
  const navBreadcrumbs = nav.breadcrumbs.example ?? [];
  const breadcrumbHtml = nav.breadcrumbs.enabled
    ? generateBreadcrumbsHTML(navBreadcrumbs, page.title)
    : "";

  // Google Font links
  const fontLinks = buildFontLinks(designSystem);

  // Build layout-specific body
  const bodyHtml = buildBodyHtml({
    page,
    content,
    heroImageUrl,
    breadcrumbHtml,
    hasContent: !!content,
  });

  // OG image meta
  const ogImage = meta.ogImageUrl ?? heroImageUrl;
  const ogMeta = ogImage
    ? `  <meta property="og:image" content="${escapeHtml(ogImage)}" />`
    : "";

  // Canonical
  const canonical = meta.canonicalUrl ? `  <link rel="canonical" href="${escapeHtml(meta.canonicalUrl)}" />` : "";

  // Published date
  const publishedMeta = meta.publishedAt
    ? `  <meta property="article:published_time" content="${escapeHtml(meta.publishedAt)}" />`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(page.title)}${page.title !== siteTitle ? ` — ${escapeHtml(siteTitle)}` : ""}</title>
${meta.description ? `  <meta name="description" content="${escapeHtml(meta.description)}" />` : ""}
  <meta property="og:title" content="${escapeHtml(meta.ogTitle ?? page.title)}" />
${meta.ogDescription ? `  <meta property="og:description" content="${escapeHtml(meta.ogDescription)}" />` : ""}
${ogMeta}
  <meta property="og:type" content="${page.pageType === "article" ? "article" : "website"}" />
${canonical}
${publishedMeta}
${meta.noIndex ? '  <meta name="robots" content="noindex" />' : ""}
  <link rel="stylesheet" href="${cssRelPath}" />
  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
${fontLinks}
  <script type="application/ld+json">${buildJsonLd(page, siteTitle, ogImage)}</script>
</head>
<body class="site-body" data-layout="${escapeHtml(page.layout)}" data-page-type="${escapeHtml(page.pageType)}">
  <header class="site-header">
    <nav class="site-nav" aria-label="Main navigation">
      ${navHtml}
    </nav>
  </header>
  <main class="site-main" id="main-content">
    ${bodyHtml}
  </main>
  <footer class="site-footer" aria-label="Site footer">
    ${footerHtml}
  </footer>
</body>
</html>`;

  const path = pageToFilePath(page.route);
  const sizeBytes = Buffer.byteLength(html, "utf8");

  return {
    file: {
      path,
      content: html,
      encoding: "utf-8",
      sizeBytes,
      fileType: "html",
      pageId: page.id,
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// buildBodyHtml — layout-specific content regions
// ---------------------------------------------------------------------------

interface BodyOpts {
  page: AssemblyPage;
  content: string;
  heroImageUrl: string | null;
  breadcrumbHtml: string;
  hasContent: boolean;
}

function buildBodyHtml(opts: BodyOpts): string {
  const { page, content, heroImageUrl, breadcrumbHtml, hasContent } = opts;

  const isArticle = ["ArticleLayout", "DocumentationLayout"].includes(page.layout);
  const isLanding = page.layout === "LandingLayout";
  const isGallery = page.layout === "GalleryLayout";

  if (isLanding && heroImageUrl) {
    return `
    <section class="site-hero">
      <img class="site-hero-bg" src="${escapeHtml(heroImageUrl)}" alt="" loading="lazy" />
      <div class="site-hero-overlay" aria-hidden="true"></div>
      <div class="site-hero-content">
        <h1>${escapeHtml(page.title)}</h1>
        ${page.meta.description ? `<p>${escapeHtml(page.meta.description)}</p>` : ""}
      </div>
    </section>
    <div class="container page-wrapper">
      ${breadcrumbHtml}
      <div class="content-body">${content || buildPlaceholderContent(page)}</div>
    </div>`;
  }

  if (isArticle) {
    const publishedDate = page.meta.publishedAt
      ? new Date(page.meta.publishedAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : null;

    return `
    <div class="content-container page-wrapper layout-article">
      ${breadcrumbHtml}
      <article class="article-layout">
        <header class="article-header">
          ${page.contentType ? `<p class="article-category">${escapeHtml(page.contentType.toLowerCase().replace(/_/g, " "))}</p>` : ""}
          <h1>${escapeHtml(page.title)}</h1>
          ${publishedDate ? `<div class="article-meta"><time datetime="${escapeHtml(page.meta.publishedAt ?? "")}">${escapeHtml(publishedDate)}</time></div>` : ""}
        </header>
        ${heroImageUrl ? `<img class="article-hero-image" src="${escapeHtml(heroImageUrl)}" alt="${escapeHtml(page.title)}" loading="eager" />` : ""}
        <div class="article-body">
          ${content || buildPlaceholderContent(page)}
        </div>
      </article>
    </div>`;
  }

  if (isGallery) {
    return `
    <div class="container page-wrapper">
      ${breadcrumbHtml}
      <div class="index-header">
        <h1>${escapeHtml(page.title)}</h1>
        ${page.meta.description ? `<p>${escapeHtml(page.meta.description)}</p>` : ""}
      </div>
      <div class="index-layout">
        <div class="content-body">${content || buildPlaceholderContent(page)}</div>
      </div>
    </div>`;
  }

  // Default: index layout
  return `
    <div class="container page-wrapper">
      ${breadcrumbHtml}
      <div class="index-layout">
        <div class="index-header">
          <h1>${escapeHtml(page.title)}</h1>
          ${page.meta.description ? `<p>${escapeHtml(page.meta.description)}</p>` : ""}
        </div>
        <div class="content-body">${hasContent ? content : buildPlaceholderContent(page)}</div>
      </div>
    </div>`;
}

function buildPlaceholderContent(page: AssemblyPage): string {
  return `<div class="card-grid" data-generated="true">
    <p class="text-muted text-sm">This page was generated from the site manifest. Content for "${escapeHtml(page.title)}" (${escapeHtml(page.pageType)}) is available in the source manifest.</p>
  </div>`;
}

function buildFontLinks(ds: DesignSystem): string {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const font of [ds.typography.headingFont, ds.typography.bodyFont]) {
    if (font.googleFontUrl && !seen.has(font.family)) {
      seen.add(font.family);
      links.push(`  <link rel="preconnect" href="https://fonts.googleapis.com" />`);
      links.push(`  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`);
      links.push(`  <link rel="stylesheet" href="${font.googleFontUrl}" />`);
    }
  }
  return links.join("\n");
}

function buildJsonLd(page: AssemblyPage, siteTitle: string, imageUrl: string | null): string {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": page.pageType === "article" ? "Article" : "WebPage",
    name: page.title,
    description: page.meta.description ?? undefined,
    url: page.meta.canonicalUrl,
  };
  if (page.pageType === "article") {
    ld["headline"] = page.title;
    if (page.meta.publishedAt) ld["datePublished"] = page.meta.publishedAt;
    if (imageUrl) ld["image"] = imageUrl;
    ld["publisher"] = { "@type": "Organization", name: siteTitle };
  }
  return JSON.stringify(ld);
}

// ---------------------------------------------------------------------------
// pageToFilePath — converts a route to a file path
// "/" → "index.html"
// "/articles/my-post" → "articles/my-post/index.html"
// ---------------------------------------------------------------------------

export function pageToFilePath(route: string): string {
  if (route === "/" || route === "") return "index.html";
  const clean = route.replace(/^\/|\/$/g, "");
  return `${clean}/index.html`;
}

// cssRelPath — relative path from a page directory back to root
export function getCssRelPath(route: string): string {
  if (route === "/" || route === "") return "styles.css";
  const depth = route.replace(/^\/|\/$/g, "").split("/").length;
  return "../".repeat(depth) + "styles.css";
}
