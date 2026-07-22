/**
 * page-generator.ts
 *
 * Generates per-route page components for the Website Prime.
 * One React component file per unique PageType found in SiteAssembly.pages.
 *
 * Pages use:
 *   - PageLayout wrapper (breadcrumbs + container)
 *   - Hero (homepage only)
 *   - ArticleCard grid (index/category/tag/homepage)
 *   - Prose article body (article/blog/guide/docs/faq)
 *   - Gallery grid (gallery/portfolio)
 *   - Search bar + results (search)
 *   - 404 fallback
 *
 * All pages are route-shell components. Content is injected at runtime via
 * props or a data-fetching hook (to be wired in Phase 5.2+).
 */

import type { SiteAssembly } from "@workspace/stencil-assembly-engine";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type { PrimeFile } from "./types.js";

type PageType = string;

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// ── Page templates ─────────────────────────────────────────────────────────

function homePage(blueprint: StencilBlueprint): string {
  const hasDropdowns = blueprint.navigation.hasDropdowns;
  const cardLayout = blueprint.cards.layout;
  const colsDesktop = blueprint.cards.columns?.desktop ?? 3;

  return `import React from 'react';
import PageLayout from '../components/PageLayout';
import Hero from '../components/Hero';
import ArticleCard from '../components/ArticleCard';

// Placeholder articles — replace with real data fetch in Phase 5.2
const PLACEHOLDER_ARTICLES = Array.from({ length: ${Math.min(colsDesktop * 2, 9)} }, (_, i) => ({
  id: String(i + 1),
  title: \`Article \${i + 1}\`,
  excerpt: 'A compelling excerpt that draws the reader in and summarises the content effectively.',
  href: \`/article-\${i + 1}\`,
  category: ['Technology', 'Design', 'Business'][i % 3],
  date: new Date(Date.now() - i * 86400000 * 3).toLocaleDateString(),
}));

export default function HomePage() {
  return (
    <>
      <Hero
        title="Welcome"
        subtitle="Discover our latest articles, guides, and resources."
        kicker="Website Prime"
        primaryCta={{ label: 'Explore', href: '#articles' }}
      />
      <PageLayout showBreadcrumbs={false}>
        <section id="articles" className="home-articles">
          <h2 className="home-articles__heading">Latest</h2>
          <div className="home-articles__grid" style={{ '--cols': '${colsDesktop}' } as React.CSSProperties}>
            {PLACEHOLDER_ARTICLES.map((a) => (
              <ArticleCard key={a.id} {...a} />
            ))}
          </div>
        </section>
        <style>{\`
          .home-articles { padding: var(--space-12, 3rem) 0; }
          .home-articles__heading { font-size: 1.75rem; font-weight: 800; margin-bottom: var(--space-6, 1.5rem); }
          .home-articles__grid { display: grid; grid-template-columns: repeat(var(--cols, 3), 1fr); gap: var(--layout-grid-gap, 1.5rem); }
          @media (max-width: 1024px) { .home-articles__grid { grid-template-columns: repeat(2, 1fr); } }
          @media (max-width: 640px) { .home-articles__grid { grid-template-columns: 1fr; } }
        \`}</style>
      </PageLayout>
    </>
  );
}
`;
}

function articlePage(): string {
  return `import React from 'react';
import PageLayout from '../components/PageLayout';

interface ArticleData {
  title: string;
  body: string;
  author?: string;
  date?: string;
  category?: string;
  readTime?: string;
}

// Placeholder content — replace with data fetch in Phase 5.2
const PLACEHOLDER: ArticleData = {
  title: 'Article Title',
  body: '<p>Article content goes here. This is where the full body of the article will be rendered once Phase 5.2 wires in data fetching.</p>',
  author: 'Author Name',
  date: new Date().toLocaleDateString(),
  category: 'Category',
  readTime: '5 min read',
};

export default function ArticlePage() {
  const article = PLACEHOLDER;
  return (
    <PageLayout narrow>
      <article className="article">
        <header className="article__header">
          {article.category && <p className="article__category">{article.category}</p>}
          <h1 className="article__title">{article.title}</h1>
          <div className="article__meta">
            {article.author && <span>{article.author}</span>}
            {article.date && <time>{article.date}</time>}
            {article.readTime && <span>{article.readTime}</span>}
          </div>
        </header>
        <div
          className="article__body prose"
          dangerouslySetInnerHTML={{ __html: article.body }}
        />
      </article>
      <style>{\`
        .article { padding: var(--space-8, 2rem) 0; }
        .article__header { margin-bottom: var(--space-8, 2rem); }
        .article__category { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-primary-600); margin-bottom: var(--space-3, 0.75rem); }
        .article__title { font-size: clamp(1.75rem, 4vw, 2.5rem); font-weight: 800; line-height: 1.15; margin-bottom: var(--space-4, 1rem); }
        .article__meta { display: flex; gap: var(--space-4, 1rem); font-size: 0.875rem; color: var(--color-text-muted, #6b7280); flex-wrap: wrap; }
        .prose { line-height: 1.75; color: var(--color-text-primary, #111827); }
        .prose p { margin-bottom: var(--space-4, 1rem); }
        .prose h2 { font-size: 1.5rem; font-weight: 700; margin: var(--space-8, 2rem) 0 var(--space-3, 0.75rem); }
        .prose h3 { font-size: 1.25rem; font-weight: 700; margin: var(--space-6, 1.5rem) 0 var(--space-2, 0.5rem); }
        .prose a { color: var(--color-primary-600); }
        .prose ul, .prose ol { padding-left: var(--space-6, 1.5rem); margin-bottom: var(--space-4, 1rem); }
        .prose li { margin-bottom: var(--space-1, 0.25rem); }
        .prose blockquote { border-left: 4px solid var(--color-primary-300, #93c5fd); padding-left: var(--space-4, 1rem); color: var(--color-text-secondary, #374151); font-style: italic; margin: var(--space-4, 1rem) 0; }
        .prose code { font-family: var(--font-mono); background: var(--color-neutral-100, #f3f4f6); padding: 0.1em 0.3em; border-radius: var(--radius-sm, 0.25rem); font-size: 0.875em; }
        .prose pre { background: var(--color-neutral-900, #111827); color: #e5e7eb; padding: var(--space-4, 1rem); border-radius: var(--radius-lg, 0.5rem); overflow-x: auto; margin: var(--space-4, 1rem) 0; }
        .prose pre code { background: none; padding: 0; }
      \`}</style>
    </PageLayout>
  );
}
`;
}

function categoryPage(): string {
  return `import React from 'react';
import { useParams } from 'react-router-dom';
import PageLayout from '../components/PageLayout';
import ArticleCard from '../components/ArticleCard';

const PLACEHOLDER_ARTICLES = Array.from({ length: 6 }, (_, i) => ({
  id: String(i + 1),
  title: \`Article \${i + 1} in this category\`,
  excerpt: 'Article excerpt summarising the content.',
  href: \`/articles/article-\${i + 1}\`,
  date: new Date(Date.now() - i * 86400000).toLocaleDateString(),
}));

export default function CategoryPage() {
  const { slug } = useParams<{ slug: string }>();
  const categoryName = (slug ?? '')
    .split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ') || 'Category';

  return (
    <PageLayout>
      <div className="category-page">
        <header className="category-page__header">
          <h1 className="category-page__title">{categoryName}</h1>
          <p className="category-page__count">{PLACEHOLDER_ARTICLES.length} articles</p>
        </header>
        <div className="category-page__grid">
          {PLACEHOLDER_ARTICLES.map((a) => (
            <ArticleCard key={a.id} {...a} />
          ))}
        </div>
      </div>
      <style>{\`
        .category-page { padding: var(--space-8, 2rem) 0; }
        .category-page__header { margin-bottom: var(--space-8, 2rem); }
        .category-page__title { font-size: 2rem; font-weight: 800; }
        .category-page__count { color: var(--color-text-muted, #6b7280); margin-top: var(--space-2, 0.5rem); }
        .category-page__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--layout-grid-gap, 1.5rem); }
        @media (max-width: 1024px) { .category-page__grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 640px) { .category-page__grid { grid-template-columns: 1fr; } }
      \`}</style>
    </PageLayout>
  );
}
`;
}

function tagPage(): string {
  return `import React from 'react';
import { useParams } from 'react-router-dom';
import PageLayout from '../components/PageLayout';
import ArticleCard from '../components/ArticleCard';

const PLACEHOLDER_ARTICLES = Array.from({ length: 4 }, (_, i) => ({
  id: String(i + 1),
  title: \`Article \${i + 1} tagged\`,
  excerpt: 'Article excerpt.',
  href: \`/articles/article-\${i + 1}\`,
  date: new Date(Date.now() - i * 86400000).toLocaleDateString(),
}));

export default function TagPage() {
  const { tag } = useParams<{ tag: string }>();
  const tagName = tag ?? 'Tag';

  return (
    <PageLayout>
      <div className="tag-page">
        <header className="tag-page__header">
          <p className="tag-page__label">Tag</p>
          <h1 className="tag-page__title">#{tagName}</h1>
        </header>
        <div className="tag-page__grid">
          {PLACEHOLDER_ARTICLES.map((a) => <ArticleCard key={a.id} {...a} />)}
        </div>
      </div>
      <style>{\`
        .tag-page { padding: var(--space-8, 2rem) 0; }
        .tag-page__label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted, #6b7280); margin-bottom: var(--space-2, 0.5rem); }
        .tag-page__title { font-size: 2rem; font-weight: 800; margin-bottom: var(--space-8, 2rem); }
        .tag-page__grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--layout-grid-gap, 1.5rem); }
        @media (max-width: 640px) { .tag-page__grid { grid-template-columns: 1fr; } }
      \`}</style>
    </PageLayout>
  );
}
`;
}

function searchPage(): string {
  return `import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageLayout from '../components/PageLayout';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) setSearchParams({ q: query.trim() });
  }

  return (
    <PageLayout>
      <div className="search-page">
        <h1 className="search-page__title">Search</h1>
        <form className="search-page__form" onSubmit={handleSubmit} role="search">
          <input
            type="search"
            className="search-page__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search articles, guides, topics…"
            aria-label="Search query"
            autoFocus
          />
          <button type="submit" className="search-page__btn">Search</button>
        </form>
        {searchParams.get('q') && (
          <p className="search-page__results-label">
            Results for <strong>"{searchParams.get('q')}"</strong>
          </p>
        )}
        {/* Phase 5.2: wire in search index query here */}
        <div className="search-page__placeholder">
          Search results will appear here once Phase 5.2 data integration is complete.
        </div>
      </div>
      <style>{\`
        .search-page { padding: var(--space-8, 2rem) 0; max-width: 680px; }
        .search-page__title { font-size: 2rem; font-weight: 800; margin-bottom: var(--space-6, 1.5rem); }
        .search-page__form { display: flex; gap: var(--space-2, 0.5rem); margin-bottom: var(--space-6, 1.5rem); }
        .search-page__input { flex: 1; padding: var(--space-3, 0.75rem) var(--space-4, 1rem); border: 2px solid var(--color-border, #e5e7eb); border-radius: var(--radius-lg, 0.5rem); font-size: 1rem; outline: none; }
        .search-page__input:focus { border-color: var(--color-primary-400, #60a5fa); }
        .search-page__btn { padding: var(--space-3, 0.75rem) var(--space-5, 1.25rem); background: var(--color-primary-600); color: #fff; border: none; border-radius: var(--radius-lg, 0.5rem); font-weight: 600; cursor: pointer; }
        .search-page__results-label { margin-bottom: var(--space-4, 1rem); color: var(--color-text-secondary, #374151); }
        .search-page__placeholder { padding: var(--space-8, 2rem); background: var(--color-surface-alt, #f9fafb); border-radius: var(--radius-lg, 0.5rem); color: var(--color-text-muted, #6b7280); text-align: center; }
      \`}</style>
    </PageLayout>
  );
}
`;
}

function galleryPage(): string {
  return `import React from 'react';
import PageLayout from '../components/PageLayout';

const PLACEHOLDER_IMAGES = Array.from({ length: 9 }, (_, i) => ({
  id: String(i + 1),
  src: \`https://picsum.photos/seed/\${i + 1}/600/400\`,
  alt: \`Gallery image \${i + 1}\`,
}));

export default function GalleryPage() {
  return (
    <PageLayout>
      <div className="gallery-page">
        <h1 className="gallery-page__title">Gallery</h1>
        <div className="gallery-page__grid">
          {PLACEHOLDER_IMAGES.map((img) => (
            <figure key={img.id} className="gallery-item">
              <img src={img.src} alt={img.alt} className="gallery-item__image" loading="lazy" />
            </figure>
          ))}
        </div>
      </div>
      <style>{\`
        .gallery-page { padding: var(--space-8, 2rem) 0; }
        .gallery-page__title { font-size: 2rem; font-weight: 800; margin-bottom: var(--space-6, 1.5rem); }
        .gallery-page__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3, 0.75rem); }
        @media (max-width: 768px) { .gallery-page__grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .gallery-page__grid { grid-template-columns: 1fr; } }
        .gallery-item { margin: 0; overflow: hidden; border-radius: var(--radius-md, 0.375rem); aspect-ratio: 3/2; }
        .gallery-item__image { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s; }
        .gallery-item:hover .gallery-item__image { transform: scale(1.05); }
      \`}</style>
    </PageLayout>
  );
}
`;
}

function notFoundPage(): string {
  return `import React from 'react';
import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <main className="not-found" id="main-content">
      <div className="container not-found__inner">
        <p className="not-found__code">404</p>
        <h1 className="not-found__title">Page Not Found</h1>
        <p className="not-found__message">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link to="/" className="not-found__home">Go Home</Link>
      </div>
      <style>{\`
        .not-found { display: flex; align-items: center; justify-content: center; min-height: 60vh; text-align: center; }
        .not-found__inner { display: flex; flex-direction: column; align-items: center; gap: var(--space-4, 1rem); }
        .not-found__code { font-size: 6rem; font-weight: 900; color: var(--color-primary-200, #bfdbfe); line-height: 1; }
        .not-found__title { font-size: 2rem; font-weight: 800; }
        .not-found__message { color: var(--color-text-secondary, #374151); font-size: 1.125rem; }
        .not-found__home { padding: var(--space-3, 0.75rem) var(--space-6, 1.5rem); background: var(--color-primary-600); color: #fff; border-radius: var(--radius-lg, 0.5rem); font-weight: 600; }
        .not-found__home:hover { background: var(--color-primary-700); color: #fff; text-decoration: none; }
      \`}</style>
    </main>
  );
}
`;
}

function genericPage(pageType: string): string {
  const title = pageType.charAt(0).toUpperCase() + pageType.slice(1).replace(/([A-Z])/g, ' $1');
  return `import React from 'react';
import PageLayout from '../components/PageLayout';

export default function ${pageType.charAt(0).toUpperCase() + pageType.slice(1)}Page() {
  return (
    <PageLayout>
      <div className="generic-page">
        <h1 className="generic-page__title">${title}</h1>
        <p className="generic-page__body">
          This page is generated from the ${pageType} stencil page type.
          Content will be populated in Phase 5.2.
        </p>
      </div>
      <style>{\`
        .generic-page { padding: var(--space-8, 2rem) 0; }
        .generic-page__title { font-size: 2rem; font-weight: 800; margin-bottom: var(--space-4, 1rem); }
        .generic-page__body { color: var(--color-text-secondary, #374151); font-size: 1.125rem; }
      \`}</style>
    </PageLayout>
  );
}
`;
}

// ── Page type → generator mapping ──────────────────────────────────────────

function pageFileForType(
  pageType: string,
  blueprint: StencilBlueprint,
): { filename: string; content: string } {
  switch (pageType) {
    case "homepage": return { filename: "HomePage", content: homePage(blueprint) };
    case "article":
    case "blog":
    case "guide":
    case "docs": return { filename: `${pageType.charAt(0).toUpperCase() + pageType.slice(1)}Page`, content: articlePage() };
    case "category": return { filename: "CategoryPage", content: categoryPage() };
    case "tag": return { filename: "TagPage", content: tagPage() };
    case "search": return { filename: "SearchPage", content: searchPage() };
    case "gallery": return { filename: "GalleryPage", content: galleryPage() };
    case "portfolio": return { filename: "PortfolioPage", content: galleryPage() };
    default: return {
      filename: `${pageType.charAt(0).toUpperCase() + pageType.slice(1)}Page`,
      content: genericPage(pageType),
    };
  }
}

// ── Main export ────────────────────────────────────────────────────────────

export function generatePages(
  assembly: SiteAssembly,
  blueprint: StencilBlueprint,
): { files: PrimeFile[]; pageTypes: string[] } {
  const pageTypes = dedupe(assembly.pages.map((p) => p.pageType));
  const files: PrimeFile[] = [];

  // Always include 404
  const pageTypeStrings: string[] = pageTypes as string[];
  if (!pageTypeStrings.includes("not_found")) {
    pageTypeStrings.push("not_found");
  }

  for (const pt of pageTypes) {
    const { filename, content } = pageFileForType(pt as string, blueprint);
    files.push({
      path: `src/pages/${filename}.tsx`,
      content,
      kind: "tsx",
    });
  }

  return { files, pageTypes };
}
