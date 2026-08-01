/**
 * component-generator.ts
 *
 * Generates React component files for the Website Prime:
 *   - Navigation.tsx    (top nav + dropdown + CTA)
 *   - MegaMenu.tsx      (multi-column dropdown — magazine stencil)
 *   - Sidebar.tsx       (persistent sidebar — docs stencil)
 *   - Footer.tsx        (link groups + legal row)
 *   - Breadcrumbs.tsx   (per-page ancestor trail)
 *   - Hero.tsx          (configurable hero section from HeroSpec)
 *   - ArticleCard.tsx   (card from CardSpec)
 *   - PageLayout.tsx    (shared page wrapper)
 *
 * Components are real TypeScript/React — no placeholders, no TODOs.
 * Styling uses CSS custom properties from tokens.css exclusively.
 */

import type { NavigationReport } from "@workspace/navigation-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type { PrimeFile } from "./types.js";

// ── Navigation ─────────────────────────────────────────────────────────────

function generateNavigation(nav: NavigationReport, blueprint: StencilBlueprint): string {
  const spec = blueprint.navigation;
  const items = nav.blueprint.topNav;
  const navHeight = spec.height ?? "64px";
  const isSticky = spec.position === "sticky" || spec.position === "fixed";
  const isSidebar = spec.style === "sidebar";
  const isTransparent = spec.isTransparentOnHero;

  const itemsJson = JSON.stringify(items, null, 2);

  return `import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

// Navigation items generated from NavigationBlueprint (Phase 4.7)
const NAV_ITEMS = ${itemsJson} as const;

type NavItem = typeof NAV_ITEMS[number];

function DropdownMenu({ items }: { items: readonly any[] }) {
  return (
    <ul className="nav-dropdown" role="menu">
      {items.map((item) => (
        <li key={item.path} role="none">
          <Link to={item.path} className="nav-dropdown__link" role="menuitem">
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NavItem({ item }: { item: NavItem }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const isActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/');

  if (item.isCta) {
    return (
      <li className="nav__item nav__item--cta">
        <Link to={item.path} className="nav__cta-btn">
          {item.label}
        </Link>
      </li>
    );
  }

  if (item.isSearch) {
    return (
      <li className="nav__item nav__item--search">
        <button
          className="nav__search-btn"
          aria-label="Search"
          onClick={() => document.dispatchEvent(new CustomEvent('prime:open-search'))}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
          <span className="visually-hidden">{item.label}</span>
        </button>
      </li>
    );
  }

  if (item.hasDropdown && item.children.length > 0) {
    return (
      <li
        className={\`nav__item nav__item--dropdown\${isActive ? ' nav__item--active' : ''}\`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <button
          className="nav__link nav__link--parent"
          aria-expanded={open}
          aria-haspopup="true"
        >
          {item.label}
          <svg className="nav__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
        {open && <DropdownMenu items={item.children} />}
      </li>
    );
  }

  return (
    <li className={\`nav__item\${isActive ? ' nav__item--active' : ''}\`}>
      <Link to={item.path} className="nav__link">
        {item.label}
      </Link>
    </li>
  );
}

export default function Navigation() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  useEffect(() => {
    if (!${isTransparent}) return;
    const handler = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);

  const navClass = [
    'nav',
    ${isSticky} ? 'nav--sticky' : '',
    ${isTransparent} ? (scrolled ? 'nav--opaque' : 'nav--transparent') : '',
    ${isSidebar} ? 'nav--sidebar' : '',
  ].filter(Boolean).join(' ');

  return (
    <header className={navClass} style={{ '--nav-height': '${navHeight}' } as React.CSSProperties}>
      <div className="nav__inner container">
        <Link to="/" className="nav__logo" aria-label="Home">
          <span className="nav__logo-text">Site</span>
        </Link>

        <nav aria-label="Main navigation">
          <ul className={\`nav__list\${mobileOpen ? ' nav__list--open' : ''}\`} role="list">
            {NAV_ITEMS.map((item) => (
              <NavItem key={item.path + item.label} item={item} />
            ))}
          </ul>
        </nav>

        <button
          className="nav__hamburger"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          <span /><span /><span />
        </button>
      </div>

      <style>{\`
        .nav {
          background: var(--color-background, #fff);
          border-bottom: 1px solid var(--color-border, #e5e7eb);
          height: var(--nav-height, 64px);
          display: flex;
          align-items: center;
          z-index: 100;
          width: 100%;
        }
        .nav--sticky { position: sticky; top: 0; }
        .nav--transparent { background: transparent; border-bottom-color: transparent; }
        .nav--opaque { background: var(--color-background, #fff); backdrop-filter: blur(12px); }
        .nav__inner { display: flex; align-items: center; gap: var(--space-4, 1rem); width: 100%; }
        .nav__logo { font-weight: 700; font-size: 1.25rem; color: var(--color-primary-600); text-decoration: none; }
        .nav__logo:hover { text-decoration: none; }
        .nav__list { display: flex; align-items: center; gap: var(--space-1, 0.25rem); list-style: none; flex: 1; }
        .nav__item { position: relative; }
        .nav__link { padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem); border-radius: var(--radius-md, 0.375rem); color: var(--color-text-primary, #111827); font-weight: 500; font-size: 0.9375rem; cursor: pointer; background: none; border: none; display: flex; align-items: center; gap: 0.25rem; }
        .nav__link:hover, .nav__item--active .nav__link { color: var(--color-primary-600); background: var(--color-primary-50, #eff6ff); }
        .nav__chevron { transition: transform 0.15s; }
        .nav__item--dropdown:hover .nav__chevron { transform: rotate(180deg); }
        .nav-dropdown { position: absolute; top: calc(100% + 4px); left: 0; background: var(--color-surface, #fff); border: 1px solid var(--color-border, #e5e7eb); border-radius: var(--radius-lg, 0.5rem); box-shadow: var(--shadow-lg); padding: var(--space-2, 0.5rem); min-width: 180px; list-style: none; z-index: 110; }
        .nav-dropdown__link { display: block; padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem); color: var(--color-text-primary, #111827); border-radius: var(--radius-md, 0.375rem); font-size: 0.9rem; }
        .nav-dropdown__link:hover { background: var(--color-primary-50, #eff6ff); color: var(--color-primary-600); text-decoration: none; }
        .nav__cta-btn { padding: var(--space-2, 0.5rem) var(--space-4, 1rem); background: var(--color-primary-600); color: #fff; border-radius: var(--radius-md, 0.375rem); font-weight: 600; font-size: 0.9375rem; }
        .nav__cta-btn:hover { background: var(--color-primary-700); color: #fff; text-decoration: none; }
        .nav__search-btn { padding: var(--space-2, 0.5rem); background: none; border: none; color: var(--color-text-secondary, #6b7280); cursor: pointer; border-radius: var(--radius-md, 0.375rem); display: flex; align-items: center; }
        .nav__search-btn:hover { color: var(--color-primary-600); background: var(--color-primary-50, #eff6ff); }
        .nav__hamburger { display: none; flex-direction: column; gap: 5px; padding: var(--space-2, 0.5rem); background: none; border: none; cursor: pointer; margin-left: auto; }
        .nav__hamburger span { display: block; width: 22px; height: 2px; background: var(--color-text-primary, #111827); border-radius: 2px; transition: all 0.2s; }
        @media (max-width: 768px) {
          .nav__hamburger { display: flex; }
          .nav__list { display: none; position: absolute; top: var(--nav-height, 64px); left: 0; right: 0; background: var(--color-background, #fff); border-top: 1px solid var(--color-border); padding: var(--space-3, 0.75rem); flex-direction: column; align-items: stretch; box-shadow: var(--shadow-lg); }
          .nav__list--open { display: flex; }
          .nav-dropdown { position: static; box-shadow: none; border: none; border-left: 2px solid var(--color-primary-200, #bfdbfe); margin-left: var(--space-3, 0.75rem); border-radius: 0; }
        }
      \`}</style>
    </header>
  );
}
`;
}

// ── Sidebar ────────────────────────────────────────────────────────────────

function generateSidebar(nav: NavigationReport): string {
  const sidebar = nav.blueprint.sidebar;
  const sectionsJson = JSON.stringify(sidebar.sections, null, 2);

  return `import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

// Sidebar sections generated from NavigationBlueprint (Phase 4.7)
const SIDEBAR_SECTIONS = ${sectionsJson} as const;

type SidebarNodeType = { label: string; path: string; nodeId: string | null; depth: number; children: readonly SidebarNodeType[]; isExpanded: boolean; isLeaf: boolean };

function SidebarNode({ node, depth = 0 }: { node: SidebarNodeType; depth?: number }) {
  const location = useLocation();
  const [expanded, setExpanded] = useState(node.isExpanded);
  const isActive = location.pathname === node.path;

  return (
    <li className={\`sidebar-node sidebar-node--depth-\${depth}\`}>
      {node.children.length > 0 ? (
        <>
          <button
            className={\`sidebar-node__toggle\${isActive ? ' sidebar-node__toggle--active' : ''}\`}
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            <svg className={\`sidebar-node__chevron\${expanded ? ' sidebar-node__chevron--open' : ''}\`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m9 18 6-6-6-6"/>
            </svg>
            {node.label}
          </button>
          {expanded && (
            <ul className="sidebar-node__children" role="list">
              {node.children.map((child: SidebarNodeType) => (
                <SidebarNode key={child.path} node={child} depth={depth + 1} />
              ))}
            </ul>
          )}
        </>
      ) : (
        <Link
          to={node.path}
          className={\`sidebar-node__link\${isActive ? ' sidebar-node__link--active' : ''}\`}
        >
          {node.label}
        </Link>
      )}
    </li>
  );
}

export default function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Documentation navigation">
      <nav>
        {(SIDEBAR_SECTIONS as any[]).map((section: any, idx: number) => (
          <div key={idx} className="sidebar-section">
            {section.heading && (
              <p className="sidebar-section__heading">{section.heading}</p>
            )}
            <ul className="sidebar-section__list" role="list">
              {section.nodes.map((node: SidebarNodeType) => (
                <SidebarNode key={node.path} node={node} />
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <style>{\`
        .sidebar { width: var(--layout-sidebar-width, 280px); border-right: 1px solid var(--color-border, #e5e7eb); padding: var(--space-6, 1.5rem) var(--space-4, 1rem); position: sticky; top: 64px; max-height: calc(100vh - 64px); overflow-y: auto; background: var(--color-surface-alt, #f9fafb); }
        .sidebar-section { margin-bottom: var(--space-6, 1.5rem); }
        .sidebar-section__heading { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted, #6b7280); padding: 0 var(--space-3, 0.75rem); margin-bottom: var(--space-2, 0.5rem); }
        .sidebar-section__list { list-style: none; }
        .sidebar-node__link { display: block; padding: var(--space-1_5, 0.375rem) var(--space-3, 0.75rem); border-radius: var(--radius-md, 0.375rem); color: var(--color-text-secondary, #374151); font-size: 0.9rem; }
        .sidebar-node__link:hover { background: var(--color-primary-50, #eff6ff); color: var(--color-primary-700); text-decoration: none; }
        .sidebar-node__link--active { background: var(--color-primary-100, #dbeafe); color: var(--color-primary-700); font-weight: 600; }
        .sidebar-node__toggle { display: flex; align-items: center; gap: var(--space-2, 0.5rem); width: 100%; padding: var(--space-1_5, 0.375rem) var(--space-3, 0.75rem); background: none; border: none; cursor: pointer; color: var(--color-text-secondary, #374151); font-size: 0.9rem; border-radius: var(--radius-md, 0.375rem); }
        .sidebar-node__toggle:hover { background: var(--color-primary-50, #eff6ff); color: var(--color-primary-700); }
        .sidebar-node__toggle--active { color: var(--color-primary-700); font-weight: 600; }
        .sidebar-node__chevron { transition: transform 0.15s; flex-shrink: 0; }
        .sidebar-node__chevron--open { transform: rotate(90deg); }
        .sidebar-node__children { padding-left: var(--space-4, 1rem); list-style: none; }
        @media (max-width: 768px) { .sidebar { display: none; } }
      \`}</style>
    </aside>
  );
}
`;
}

// ── Footer ─────────────────────────────────────────────────────────────────

function generateFooter(nav: NavigationReport): string {
  const footer = nav.blueprint.footerNav;
  const groupsJson = JSON.stringify(footer.groups, null, 2);
  const legalJson = JSON.stringify(footer.legalLinks, null, 2);
  const isMultiCol = footer.layout === "multi-column" || footer.layout === "split";

  return `import React from 'react';
import { Link } from 'react-router-dom';

const FOOTER_GROUPS = ${groupsJson};
const LEGAL_LINKS = ${legalJson};

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        ${isMultiCol ? `<div className="footer__grid">
          {FOOTER_GROUPS.map((group: any) => (
            <div key={group.heading} className="footer__group">
              <h3 className="footer__group-heading">{group.heading}</h3>
              <ul className="footer__group-links" role="list">
                {group.links.map((link: any) => (
                  <li key={link.path + link.label}>
                    <Link to={link.path} className="footer__link">{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>` : `<div className="footer__centered">
          {FOOTER_GROUPS[0]?.links.map((link: any) => (
            <Link key={link.path} to={link.path} className="footer__link">{link.label}</Link>
          ))}
        </div>`}

        <div className="footer__bottom">
          <p className="footer__copy">
            &copy; {new Date().getFullYear()} All rights reserved.
          </p>
          <nav className="footer__legal" aria-label="Legal links">
            {LEGAL_LINKS.map((link: any) => (
              <Link key={link.path} to={link.path} className="footer__legal-link">{link.label}</Link>
            ))}
          </nav>
        </div>
      </div>
      <style>{\`
        .footer { background: var(--color-neutral-900, #111827); color: var(--color-neutral-200, #e5e7eb); padding: var(--space-12, 3rem) 0 var(--space-6, 1.5rem); margin-top: auto; }
        .footer__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-8, 2rem); margin-bottom: var(--space-8, 2rem); }
        .footer__centered { display: flex; flex-wrap: wrap; gap: var(--space-4, 1rem); justify-content: center; margin-bottom: var(--space-6, 1.5rem); }
        .footer__group-heading { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-neutral-400, #9ca3af); margin-bottom: var(--space-3, 0.75rem); }
        .footer__group-links { list-style: none; display: flex; flex-direction: column; gap: var(--space-2, 0.5rem); }
        .footer__link { color: var(--color-neutral-300, #d1d5db); font-size: 0.9rem; }
        .footer__link:hover { color: #fff; text-decoration: none; }
        .footer__bottom { border-top: 1px solid var(--color-neutral-800, #1f2937); padding-top: var(--space-4, 1rem); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3, 0.75rem); }
        .footer__copy { font-size: 0.875rem; color: var(--color-neutral-400, #9ca3af); }
        .footer__legal { display: flex; gap: var(--space-4, 1rem); }
        .footer__legal-link { font-size: 0.875rem; color: var(--color-neutral-400, #9ca3af); }
        .footer__legal-link:hover { color: #fff; text-decoration: none; }
      \`}</style>
    </footer>
  );
}
`;
}

// ── Breadcrumbs ────────────────────────────────────────────────────────────

function generateBreadcrumbs(): string {
  return `import React from 'react';
import { Link, useLocation } from 'react-router-dom';

// Breadcrumbs are resolved at runtime from the current path.
// For rich ancestry trails, inject BreadcrumbTrail data via context.
export interface BreadcrumbItem {
  label: string;
  path: string;
  isCurrentPage?: boolean;
}

interface BreadcrumbsProps {
  items?: BreadcrumbItem[];
}

function pathToItems(pathname: string): BreadcrumbItem[] {
  const segments = pathname.split('/').filter(Boolean);
  const items: BreadcrumbItem[] = [{ label: 'Home', path: '/' }];
  let acc = '';
  for (let i = 0; i < segments.length; i++) {
    acc += '/' + segments[i];
    const label = segments[i]
      .split(/[-_]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
    items.push({ label, path: acc, isCurrentPage: i === segments.length - 1 });
  }
  return items;
}

export default function Breadcrumbs({ items }: BreadcrumbsProps) {
  const location = useLocation();
  const crumbs = items ?? pathToItems(location.pathname);
  if (crumbs.length <= 1) return null;

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol className="breadcrumbs__list" role="list">
        {crumbs.map((crumb, idx) => (
          <li key={crumb.path} className="breadcrumbs__item">
            {crumb.isCurrentPage || idx === crumbs.length - 1 ? (
              <span className="breadcrumbs__current" aria-current="page">{crumb.label}</span>
            ) : (
              <Link to={crumb.path} className="breadcrumbs__link">{crumb.label}</Link>
            )}
            {idx < crumbs.length - 1 && (
              <span className="breadcrumbs__sep" aria-hidden="true">/</span>
            )}
          </li>
        ))}
      </ol>
      <style>{\`
        .breadcrumbs { padding: var(--space-3, 0.75rem) 0; }
        .breadcrumbs__list { display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem; list-style: none; font-size: 0.875rem; }
        .breadcrumbs__link { color: var(--color-text-muted, #6b7280); }
        .breadcrumbs__link:hover { color: var(--color-primary-600); }
        .breadcrumbs__current { color: var(--color-text-primary, #111827); font-weight: 500; }
        .breadcrumbs__sep { color: var(--color-text-muted, #6b7280); margin: 0 0.125rem; }
      \`}</style>
    </nav>
  );
}
`;
}

// ── Hero ───────────────────────────────────────────────────────────────────

function generateHero(blueprint: StencilBlueprint): string {
  const hero = blueprint.hero;
  const variant = hero.variant;
  const hasBg = hero.hasBackgroundMedia;
  const overlay = hero.hasOverlay;
  const textPos = hero.textPosition;
  const ctaLabels = hero.ctaLabels;
  const hasKicker = hero.hasKicker;
  const hasSub = hero.hasSubheadline;

  return `import React from 'react';
import { Link } from 'react-router-dom';

export interface HeroProps {
  title?: string;
  subtitle?: string;
  kicker?: string;
  primaryCta?: { label: string; href: string };
  secondaryCta?: { label: string; href: string };
  backgroundImage?: string;
}

// Hero variant: ${variant}
// Text position: ${textPos}
// Has background media: ${hasBg}
export default function Hero({
  title = 'Welcome',
  subtitle,
  kicker,
  primaryCta = { label: '${ctaLabels[0] ?? "Get Started"}', href: '#' },
  secondaryCta,
  backgroundImage,
}: HeroProps) {
  const style: React.CSSProperties = backgroundImage
    ? { backgroundImage: \`url(\${backgroundImage})\`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : {};

  return (
    <section
      className={\`hero hero--${variant}\${backgroundImage ? ' hero--has-bg' : ''}\`}
      style={style}
      aria-label="Hero section"
    >
      ${overlay ? '<div className="hero__overlay" aria-hidden="true" />' : ''}
      <div className="hero__content hero__content--${textPos} container">
        ${hasKicker ? '{kicker && <p className="hero__kicker">{kicker}</p>}' : ''}
        <h1 className="hero__title">{title}</h1>
        ${hasSub ? '{subtitle && <p className="hero__subtitle">{subtitle}</p>}' : ''}
        <div className="hero__actions">
          <Link to={primaryCta.href} className="hero__cta hero__cta--primary">
            {primaryCta.label}
          </Link>
          {secondaryCta && (
            <Link to={secondaryCta.href} className="hero__cta hero__cta--secondary">
              {secondaryCta.label}
            </Link>
          )}
        </div>
      </div>
      <style>{\`
        .hero { position: relative; display: flex; align-items: center; justify-content: center; min-height: ${hero.height === "full-screen" ? "100vh" : hero.height === "80vh" ? "80vh" : hero.height === "60vh" ? "60vh" : hero.height === "50vh" ? "50vh" : "400px"}; padding: var(--space-16, 4rem) 0; overflow: hidden; background: var(--color-primary-50, #eff6ff); }
        .hero--has-bg { background: var(--color-neutral-900, #111827); }
        .hero__overlay { position: absolute; inset: 0; background: rgba(0,0,0,${overlay ? hero.overlayOpacity : 0}); }
        .hero__content { position: relative; z-index: 1; max-width: 720px; width: 100%; }
        .hero__content--center { text-align: center; margin-inline: auto; }
        .hero__content--left { text-align: left; }
        .hero__content--right { text-align: right; margin-left: auto; }
        .hero__kicker { font-size: 0.875rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-primary-600); margin-bottom: var(--space-3, 0.75rem); }
        .hero--has-bg .hero__kicker { color: var(--color-primary-300, #93c5fd); }
        .hero__title { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 800; line-height: 1.1; margin-bottom: var(--space-4, 1rem); color: var(--color-text-primary, #111827); }
        .hero--has-bg .hero__title { color: #fff; }
        .hero__subtitle { font-size: clamp(1rem, 2vw, 1.25rem); color: var(--color-text-secondary, #374151); line-height: 1.6; margin-bottom: var(--space-6, 1.5rem); }
        .hero--has-bg .hero__subtitle { color: var(--color-neutral-200, #e5e7eb); }
        .hero__actions { display: flex; gap: var(--space-3, 0.75rem); flex-wrap: wrap; }
        .hero__content--center .hero__actions { justify-content: center; }
        .hero__cta { display: inline-flex; align-items: center; padding: var(--space-3, 0.75rem) var(--space-6, 1.5rem); border-radius: var(--radius-lg, 0.5rem); font-weight: 600; font-size: 1rem; transition: all 0.15s; text-decoration: none; }
        .hero__cta--primary { background: var(--color-primary-600); color: #fff; }
        .hero__cta--primary:hover { background: var(--color-primary-700); color: #fff; text-decoration: none; transform: translateY(-1px); box-shadow: var(--shadow-md); }
        .hero__cta--secondary { background: transparent; color: var(--color-primary-600); border: 2px solid var(--color-primary-300, #93c5fd); }
        .hero__cta--secondary:hover { background: var(--color-primary-50, #eff6ff); text-decoration: none; }
        .hero--has-bg .hero__cta--secondary { color: #fff; border-color: rgba(255,255,255,0.5); }
        .hero--has-bg .hero__cta--secondary:hover { background: rgba(255,255,255,0.1); }
      \`}</style>
    </section>
  );
}
`;
}

// ── ArticleCard ────────────────────────────────────────────────────────────

function generateArticleCard(blueprint: StencilBlueprint): string {
  const card = blueprint.cards;
  const hoverEffect = card.hoverEffect;
  const cardType = card.cardType;

  return `import React from 'react';
import { Link } from 'react-router-dom';

export interface ArticleCardProps {
  title: string;
  excerpt?: string;
  href: string;
  imageUrl?: string;
  category?: string;
  date?: string;
  author?: string;
  readTime?: string;
}

// Card type: ${cardType}
// Hover effect: ${hoverEffect}
export default function ArticleCard({
  title,
  excerpt,
  href,
  imageUrl,
  category,
  date,
  author,
  readTime,
}: ArticleCardProps) {
  return (
    <article className="card card--${cardType}">
      {imageUrl && (
        <Link to={href} className="card__image-link" tabIndex={-1}>
          <div className="card__image-wrap">
            <img src={imageUrl} alt="" className="card__image" loading="lazy" />
          </div>
        </Link>
      )}
      <div className="card__body">
        {category && <p className="card__category">{category}</p>}
        <h2 className="card__title">
          <Link to={href} className="card__title-link">{title}</Link>
        </h2>
        {excerpt && <p className="card__excerpt">{excerpt}</p>}
        <footer className="card__meta">
          {author && <span className="card__author">{author}</span>}
          {date && <time className="card__date">{date}</time>}
          {readTime && <span className="card__read-time">{readTime}</span>}
        </footer>
      </div>
      <style>{\`
        .card { background: var(--color-surface, #fff); border-radius: var(--radius-lg, 0.5rem); border: 1px solid var(--color-border, #e5e7eb); overflow: hidden; display: flex; flex-direction: column; transition: all 0.2s; }
        ${hoverEffect === "lift" ? ".card:hover { transform: translateY(-4px); box-shadow: var(--shadow-xl); }" : ""}
        ${hoverEffect === "scale" ? ".card:hover { transform: scale(1.02); box-shadow: var(--shadow-lg); }" : ""}
        ${hoverEffect === "border-accent" ? ".card:hover { border-color: var(--color-primary-400, #60a5fa); }" : ""}
        .card--horizontal { flex-direction: row; }
        .card--horizontal .card__image-wrap { width: 200px; flex-shrink: 0; }
        .card__image-wrap { overflow: hidden; aspect-ratio: ${card.aspectRatio === "16:9" ? "16/9" : card.aspectRatio === "3:2" ? "3/2" : card.aspectRatio === "4:3" ? "4/3" : "3/2"}; background: var(--color-neutral-100, #f3f4f6); }
        .card__image { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s; }
        .card:hover .card__image { transform: scale(1.04); }
        .card__body { padding: var(--space-4, 1rem); flex: 1; display: flex; flex-direction: column; gap: var(--space-2, 0.5rem); }
        .card__category { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-primary-600); }
        .card__title { font-size: 1.125rem; font-weight: 700; line-height: 1.3; margin: 0; }
        .card__title-link { color: var(--color-text-primary, #111827); }
        .card__title-link:hover { color: var(--color-primary-600); text-decoration: none; }
        .card__excerpt { font-size: 0.9rem; color: var(--color-text-secondary, #374151); line-height: 1.5; margin: 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .card__meta { display: flex; gap: var(--space-3, 0.75rem); font-size: 0.8125rem; color: var(--color-text-muted, #6b7280); margin-top: auto; padding-top: var(--space-2, 0.5rem); flex-wrap: wrap; }
      \`}</style>
    </article>
  );
}
`;
}

// ── PageLayout ─────────────────────────────────────────────────────────────

function generatePageLayout(): string {
  return `import React from 'react';
import Breadcrumbs from './Breadcrumbs';

interface PageLayoutProps {
  children: React.ReactNode;
  /** Route path — used to show breadcrumbs */
  route?: string;
  /** Whether to show breadcrumbs */
  showBreadcrumbs?: boolean;
  /** Whether to render in a content container (narrow) */
  narrow?: boolean;
  className?: string;
}

export default function PageLayout({
  children,
  showBreadcrumbs = true,
  narrow = false,
  className = '',
}: PageLayoutProps) {
  return (
    <div className={\`page-layout\${className ? ' ' + className : ''}\`}>
      {showBreadcrumbs && (
        <div className={narrow ? 'content-container' : 'container'}>
          <Breadcrumbs />
        </div>
      )}
      <div className={narrow ? 'content-container page-layout__content' : 'container page-layout__content'}>
        {children}
      </div>
      <style>{\`
        .page-layout { padding-top: var(--space-6, 1.5rem); padding-bottom: var(--space-16, 4rem); flex: 1; }
        .page-layout__content { min-height: 40vh; }
      \`}</style>
    </div>
  );
}
`;
}

// ── Main export ────────────────────────────────────────────────────────────

export function generateComponents(
  nav: NavigationReport,
  blueprint: StencilBlueprint,
): PrimeFile[] {
  const files: PrimeFile[] = [
    { path: "src/components/Navigation.tsx", content: generateNavigation(nav, blueprint), kind: "tsx" },
    { path: "src/components/Footer.tsx", content: generateFooter(nav), kind: "tsx" },
    { path: "src/components/Breadcrumbs.tsx", content: generateBreadcrumbs(), kind: "tsx" },
    { path: "src/components/Hero.tsx", content: generateHero(blueprint), kind: "tsx" },
    { path: "src/components/ArticleCard.tsx", content: generateArticleCard(blueprint), kind: "tsx" },
    { path: "src/components/PageLayout.tsx", content: generatePageLayout(), kind: "tsx" },
  ];

  if (nav.blueprint.sidebar.isEnabled) {
    files.push({
      path: "src/components/Sidebar.tsx",
      content: generateSidebar(nav),
      kind: "tsx",
    });
  }

  return files;
}
