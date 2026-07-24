import type { DesignSystem } from "@workspace/theme-intelligence";

// ---------------------------------------------------------------------------
// generateCSS
// Converts a DesignSystem into a complete CSS stylesheet.
// Output is a single self-contained CSS file with:
//   - CSS custom properties (design tokens)
//   - Base reset + typography
//   - Layout primitives
//   - Navigation styles
//   - Article / content styles
//   - Category / index page styles
//   - Footer styles
//   - Responsive breakpoints
// ---------------------------------------------------------------------------

export function generateCSS(ds: DesignSystem): string {
  const t = ds.tokens;
  const c = t.colors;
  const ty = t.typography;
  const sp = t.spacing;
  const rad = t.radius;
  const sh = t.shadows;
  const anim = t.animation;
  const layout = t.layout;

  const headingFont = `'${ty.fontFamilies.heading}', ${ds.typography.headingFont.fallback}`;
  const bodyFont = `'${ty.fontFamilies.body}', ${ds.typography.bodyFont.fallback}`;
  const monoFont = `'${ty.fontFamilies.mono}', monospace`;

  const nav = ds.componentStyling.navigation;
  const card = ds.componentStyling.card;
  const hero = ds.componentStyling.hero;

  const navBg =
    nav.background === "transparent"
      ? "transparent"
      : nav.background === "blur"
        ? `rgba(255,255,255,0.85)`
        : c.semantic.background;

  const navBackdrop = nav.background === "blur" ? "blur(12px)" : "none";
  const navPosition = nav.position;

  const cardRadius = ds.layout.cardBorderRadius ?? rad.lg;
  const cardShadowValue =
    ds.layout.cardShadow === "none"
      ? sh.none
      : ds.layout.cardShadow === "subtle"
        ? sh.sm
        : ds.layout.cardShadow === "medium"
          ? sh.md
          : sh.lg;

  const gridCols = ds.density.cardsPerRow;

  const googleFontImports = buildGoogleFontImports(ds);

  return `${googleFontImports}

/* ============================================================
   CSS Custom Properties — Design Tokens
   ============================================================ */
:root {
  /* Colors — Primary */
  --color-primary-50: ${c.primary[50]};
  --color-primary-100: ${c.primary[100]};
  --color-primary-200: ${c.primary[200]};
  --color-primary-300: ${c.primary[300]};
  --color-primary-400: ${c.primary[400]};
  --color-primary-500: ${c.primary[500]};
  --color-primary-600: ${c.primary[600]};
  --color-primary-700: ${c.primary[700]};
  --color-primary-800: ${c.primary[800]};
  --color-primary-900: ${c.primary[900]};
  --color-primary-950: ${c.primary[950]};

  /* Colors — Secondary */
  --color-secondary-50: ${c.secondary[50]};
  --color-secondary-500: ${c.secondary[500]};
  --color-secondary-700: ${c.secondary[700]};
  --color-secondary-900: ${c.secondary[900]};

  /* Colors — Accent */
  --color-accent-400: ${c.accent[400]};
  --color-accent-500: ${c.accent[500]};
  --color-accent-600: ${c.accent[600]};

  /* Colors — Neutral */
  --color-neutral-50: ${c.neutral[50]};
  --color-neutral-100: ${c.neutral[100]};
  --color-neutral-200: ${c.neutral[200]};
  --color-neutral-300: ${c.neutral[300]};
  --color-neutral-400: ${c.neutral[400]};
  --color-neutral-500: ${c.neutral[500]};
  --color-neutral-600: ${c.neutral[600]};
  --color-neutral-700: ${c.neutral[700]};
  --color-neutral-800: ${c.neutral[800]};
  --color-neutral-900: ${c.neutral[900]};

  /* Semantic Colors */
  --color-bg: ${c.semantic.background};
  --color-surface: ${c.semantic.surface};
  --color-surface-alt: ${c.semantic.surfaceAlt};
  --color-border: ${c.semantic.border};
  --color-border-strong: ${c.semantic.borderStrong};
  --color-text: ${c.semantic.textPrimary};
  --color-text-secondary: ${c.semantic.textSecondary};
  --color-text-muted: ${c.semantic.textMuted};
  --color-text-inverse: ${c.semantic.textInverse};
  --color-link: ${c.semantic.link};
  --color-link-hover: ${c.semantic.linkHover};

  /* Typography */
  --font-heading: ${headingFont};
  --font-body: ${bodyFont};
  --font-mono: ${monoFont};
  --font-size-xs: ${ty.fontSizes["xs"] ?? "0.75rem"};
  --font-size-sm: ${ty.fontSizes["sm"] ?? "0.875rem"};
  --font-size-base: ${ty.fontSizes["base"] ?? "1rem"};
  --font-size-lg: ${ty.fontSizes["lg"] ?? "1.125rem"};
  --font-size-xl: ${ty.fontSizes["xl"] ?? "1.25rem"};
  --font-size-2xl: ${ty.fontSizes["2xl"] ?? "1.5rem"};
  --font-size-3xl: ${ty.fontSizes["3xl"] ?? "1.875rem"};
  --font-size-4xl: ${ty.fontSizes["4xl"] ?? "2.25rem"};
  --font-size-5xl: ${ty.fontSizes["5xl"] ?? "3rem"};

  /* Spacing */
  --space-1: ${sp[1]};
  --space-2: ${sp[2]};
  --space-3: ${sp[3]};
  --space-4: ${sp[4]};
  --space-5: ${sp[5]};
  --space-6: ${sp[6]};
  --space-8: ${sp[8]};
  --space-10: ${sp[10]};
  --space-12: ${sp[12]};
  --space-16: ${sp[16]};
  --space-20: ${sp[20]};
  --space-24: ${sp[24]};

  /* Radius */
  --radius-sm: ${rad.sm};
  --radius-md: ${rad.md};
  --radius-lg: ${rad.lg};
  --radius-xl: ${rad.xl};
  --radius-full: ${rad.full};

  /* Shadows */
  --shadow-sm: ${sh.sm};
  --shadow-md: ${sh.md};
  --shadow-lg: ${sh.lg};

  /* Animation */
  --duration-fast: ${anim.durationFast};
  --duration-base: ${anim.durationBase};
  --easing-default: ${anim.easingDefault};

  /* Layout */
  --container-max: ${layout.containerMaxWidth};
  --content-max: ${layout.contentMaxWidth};
  --sidebar-width: ${layout.sidebarWidth};
  --grid-gap: ${layout.gridGap};

  /* Component */
  --card-radius: ${cardRadius};
  --card-shadow: ${cardShadowValue};
}

/* ============================================================
   Base Reset
   ============================================================ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html {
  font-size: ${ds.typography.baseFontSize ?? "16px"};
  scroll-behavior: smooth;
  -webkit-text-size-adjust: 100%;
}

body {
  font-family: var(--font-body);
  font-size: var(--font-size-base);
  line-height: ${ds.typography.baseLineHeight ?? "1.6"};
  color: var(--color-text);
  background-color: var(--color-bg);
  min-height: 100vh;
}

img, video { max-width: 100%; height: auto; display: block; }

a {
  color: var(--color-link);
  text-decoration: none;
  transition: color var(--duration-fast) var(--easing-default);
}
a:hover { color: var(--color-link-hover); }

ul, ol { list-style: none; }

/* ============================================================
   Typography
   ============================================================ */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: ${ds.typography.headingTracking ?? "-0.02em"};
  color: var(--color-text);
}
h1 { font-size: var(--font-size-4xl); }
h2 { font-size: var(--font-size-3xl); }
h3 { font-size: var(--font-size-2xl); }
h4 { font-size: var(--font-size-xl); }
h5 { font-size: var(--font-size-lg); }
h6 { font-size: var(--font-size-base); font-weight: 600; }

p { margin-bottom: ${ds.typography.paragraphSpacing ?? "1rem"}; }
p:last-child { margin-bottom: 0; }

strong, b { font-weight: 700; }
em, i { font-style: italic; }

code, pre {
  font-family: var(--font-mono);
  font-size: 0.875em;
}
pre {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  overflow-x: auto;
  margin-bottom: var(--space-4);
}
code { background: var(--color-surface-alt); padding: 0.125em 0.375em; border-radius: var(--radius-sm); }

blockquote {
  border-left: 3px solid var(--color-primary-500);
  padding: var(--space-4) var(--space-6);
  margin: var(--space-6) 0;
  background: var(--color-surface);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  font-style: italic;
  color: var(--color-text-secondary);
}

hr { border: none; border-top: 1px solid var(--color-border); margin: var(--space-8) 0; }

/* ============================================================
   Layout
   ============================================================ */
.site-body { display: flex; flex-direction: column; min-height: 100vh; }

.container {
  width: 100%;
  max-width: var(--container-max);
  margin-inline: auto;
  padding-inline: var(--space-6);
}

.content-container {
  width: 100%;
  max-width: var(--content-max);
  margin-inline: auto;
  padding-inline: var(--space-6);
}

.site-main { flex: 1; }

/* ============================================================
   Navigation
   ============================================================ */
.site-header {
  position: ${navPosition};
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: ${navBg};
  backdrop-filter: ${navBackdrop};
  -webkit-backdrop-filter: ${navBackdrop};
  border-bottom: 1px solid var(--color-border);
  height: ${nav.height ?? "64px"};
  display: flex;
  align-items: center;
}

.site-nav {
  width: 100%;
  max-width: var(--container-max);
  margin-inline: auto;
  padding-inline: var(--space-6);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-8);
}

.site-logo {
  font-family: var(--font-heading);
  font-size: var(--font-size-xl);
  font-weight: 800;
  color: var(--color-text);
  white-space: nowrap;
  flex-shrink: 0;
}
.site-logo:hover { color: var(--color-primary-600); }

.nav-links {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: nowrap;
  overflow: hidden;
}

.nav-link {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  white-space: nowrap;
  transition: background var(--duration-fast) var(--easing-default),
              color var(--duration-fast) var(--easing-default);
}
.nav-link:hover, .nav-link.active {
  color: var(--color-text);
  background: var(--color-surface-alt);
}

.nav-has-children { position: relative; }
.nav-has-children > .nav-link::after { content: ' ▾'; font-size: 0.7em; }
.nav-dropdown {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 180px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-2);
  z-index: 200;
}
.nav-has-children:hover .nav-dropdown { display: block; }
.nav-dropdown .nav-link { display: block; width: 100%; }

${navPosition === "sticky" ? `body { scroll-padding-top: ${nav.height ?? "64px"}; }` : ""}

/* ============================================================
   Breadcrumbs
   ============================================================ */
.breadcrumbs {
  padding: var(--space-3) 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.breadcrumb-sep { color: var(--color-border-strong); }
.breadcrumb-link { color: var(--color-text-secondary); }
.breadcrumb-link:hover { color: var(--color-text); }
.breadcrumb-current { color: var(--color-text); font-weight: 500; }

/* ============================================================
   Page layouts
   ============================================================ */
.page-wrapper {
  padding-top: var(--space-10);
  padding-bottom: var(--space-16);
}

.page-wrapper.layout-article { padding-top: var(--space-8); }

/* Article Layout */
.article-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-8);
  max-width: var(--content-max);
  margin-inline: auto;
  padding-inline: var(--space-6);
}

.article-header { margin-bottom: var(--space-8); }
.article-header .article-category {
  font-size: var(--font-size-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-primary-600);
  margin-bottom: var(--space-3);
}
.article-header h1 { margin-bottom: var(--space-4); line-height: 1.15; }
.article-header .article-meta {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.article-hero-image {
  width: 100%;
  aspect-ratio: 16/9;
  object-fit: cover;
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-8);
}

.article-body {
  font-size: var(--font-size-lg);
  line-height: 1.75;
}
.article-body h2 { font-size: var(--font-size-2xl); margin-top: var(--space-8); margin-bottom: var(--space-4); }
.article-body h3 { font-size: var(--font-size-xl); margin-top: var(--space-6); margin-bottom: var(--space-3); }
.article-body p { margin-bottom: var(--space-6); }
.article-body ul, .article-body ol {
  padding-left: var(--space-6);
  margin-bottom: var(--space-6);
}
.article-body ul { list-style: disc; }
.article-body ol { list-style: decimal; }
.article-body li { margin-bottom: var(--space-2); }
.article-body img {
  border-radius: var(--radius-md);
  margin: var(--space-6) auto;
  box-shadow: var(--shadow-md);
}
.article-body a { text-decoration: underline; text-underline-offset: 2px; }
.article-body table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: var(--space-6);
}
.article-body th, .article-body td {
  border: 1px solid var(--color-border);
  padding: var(--space-3) var(--space-4);
  text-align: left;
}
.article-body th {
  background: var(--color-surface);
  font-weight: 600;
}

/* Index / Category Layout */
.index-layout {
  max-width: var(--container-max);
  margin-inline: auto;
  padding-inline: var(--space-6);
}

.index-header { margin-bottom: var(--space-10); }
.index-header h1 { font-size: var(--font-size-4xl); margin-bottom: var(--space-3); }
.index-header p { font-size: var(--font-size-lg); color: var(--color-text-secondary); }

.card-grid {
  display: grid;
  grid-template-columns: repeat(${gridCols.desktop}, 1fr);
  gap: var(--grid-gap);
}

.card {
  background: var(--color-surface);
  border-radius: var(--card-radius);
  box-shadow: var(--card-shadow);
  ${ds.layout.cardBorder ? "border: 1px solid var(--color-border);" : ""}
  overflow: hidden;
  transition: transform var(--duration-fast) var(--easing-default),
              box-shadow var(--duration-fast) var(--easing-default);
  display: flex;
  flex-direction: ${card.layout === "horizontal" ? "row" : "column"};
}
.card:hover {
  transform: ${card.hoverEffect === "lift" ? "translateY(-4px)" : card.hoverEffect === "scale" ? "scale(1.02)" : "none"};
  box-shadow: var(--shadow-lg);
  ${card.hoverEffect === "border-accent" ? "border-color: var(--color-primary-500);" : ""}
}

.card-image-wrap {
  overflow: hidden;
  aspect-ratio: 16/9;
  ${card.layout === "horizontal" ? "width: 280px; flex-shrink: 0;" : ""}
}
.card-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--duration-base) var(--easing-default);
}
.card:hover .card-image { transform: scale(1.04); }

.card-body { padding: var(--space-5); flex: 1; display: flex; flex-direction: column; }

.card-category {
  font-size: var(--font-size-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-primary-600);
  margin-bottom: var(--space-2);
}

.card-title {
  font-size: var(--font-size-lg);
  font-weight: 700;
  font-family: var(--font-heading);
  margin-bottom: var(--space-2);
  line-height: 1.3;
  color: var(--color-text);
}
.card-title a { color: inherit; }
.card-title a:hover { color: var(--color-primary-600); }

.card-excerpt {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
  flex: 1;
  margin-bottom: var(--space-3);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-meta {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: auto;
}

/* Hero section */
.site-hero {
  min-height: ${hero.minHeight ?? "400px"};
  display: flex;
  align-items: center;
  position: relative;
  overflow: hidden;
  background: var(--color-primary-900);
}
.site-hero-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: ${1 - (hero.overlayOpacity ?? 0.5)};
}
.site-hero-overlay {
  position: absolute;
  inset: 0;
  background: ${hero.overlayColor ?? "rgba(0,0,0,0.5)"};
  opacity: ${hero.overlayOpacity ?? 0.5};
}
.site-hero-content {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: var(--container-max);
  margin-inline: auto;
  padding: var(--space-16) var(--space-6);
  ${hero.layout === "text-centered" ? "text-align: center;" : ""}
}
.site-hero-content h1 {
  font-size: var(--font-size-5xl);
  color: ${hero.textColor ?? "#ffffff"};
  margin-bottom: var(--space-4);
}
.site-hero-content p {
  font-size: var(--font-size-xl);
  color: ${hero.textColor ?? "#ffffff"};
  opacity: 0.85;
  max-width: 600px;
  ${hero.layout === "text-centered" ? "margin-inline: auto;" : ""}
}

/* ============================================================
   Footer
   ============================================================ */
.site-footer {
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  padding: var(--space-12) var(--space-6);
  margin-top: var(--space-16);
}
.footer-inner {
  max-width: var(--container-max);
  margin-inline: auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-8);
}
.footer-group h4 {
  font-size: var(--font-size-sm);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  margin-bottom: var(--space-4);
}
.footer-group ul { display: flex; flex-direction: column; gap: var(--space-2); }
.footer-group li a {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
.footer-group li a:hover { color: var(--color-text); }
.footer-bottom {
  max-width: var(--container-max);
  margin-inline: auto;
  padding-top: var(--space-8);
  margin-top: var(--space-8);
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

/* ============================================================
   Pagination
   ============================================================ */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-10);
}
.pagination a, .pagination span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.25rem;
  height: 2.25rem;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 500;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  transition: all var(--duration-fast) var(--easing-default);
}
.pagination a:hover { background: var(--color-surface-alt); color: var(--color-text); }
.pagination .active { background: var(--color-primary-600); color: white; border-color: var(--color-primary-600); }

/* ============================================================
   Utilities
   ============================================================ */
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.text-muted { color: var(--color-text-muted); }
.text-secondary { color: var(--color-text-secondary); }
.text-sm { font-size: var(--font-size-sm); }
.tag { display: inline-block; padding: var(--space-1) var(--space-3); background: var(--color-surface-alt); border-radius: var(--radius-full); font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.tag:hover { background: var(--color-primary-100); color: var(--color-primary-700); }

/* ============================================================
   Responsive
   ============================================================ */
@media (max-width: 1024px) {
  .card-grid { grid-template-columns: repeat(${Math.max(1, gridCols.tablet)}, 1fr); }
}
@media (max-width: 768px) {
  h1 { font-size: var(--font-size-3xl); }
  h2 { font-size: var(--font-size-2xl); }
  .card-grid { grid-template-columns: repeat(${Math.max(1, gridCols.mobile)}, 1fr); }
  .card { flex-direction: column; }
  .card-image-wrap { width: 100%; }
  .nav-links { display: none; }
  .footer-inner { grid-template-columns: repeat(2, 1fr); }
  .site-hero-content h1 { font-size: var(--font-size-3xl); }
  .article-body { font-size: var(--font-size-base); }
}
@media (max-width: 480px) {
  .container, .content-container { padding-inline: var(--space-4); }
  .footer-inner { grid-template-columns: 1fr; }
}
`;
}

function buildGoogleFontImports(ds: DesignSystem): string {
  const fonts: string[] = [];
  const seen = new Set<string>();

  for (const fontDef of [
    ds.typography.headingFont,
    ds.typography.bodyFont,
    ds.typography.monoFont,
  ]) {
    if (fontDef.googleFontUrl && !seen.has(fontDef.family)) {
      seen.add(fontDef.family);
      fonts.push(`@import url('${fontDef.googleFontUrl}');`);
    }
  }
  return fonts.join("\n");
}
