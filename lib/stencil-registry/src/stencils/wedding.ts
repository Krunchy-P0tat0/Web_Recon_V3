import type { StencilDefinition } from "../types.js";

/**
 * Wedding — Event and wedding website.
 *
 * Personal, occasion-specific site. Visual-first with large galleries,
 * an event schedule/FAQ, and minimal navigational complexity.
 * RSVP and venue information drive the layout.
 */
export const weddingStencil: StencilDefinition = {
  id: "wedding",
  displayName: "Wedding",
  description:
    "Personal event or wedding website. Visual-first with a full-bleed hero, " +
    "large image galleries, event schedule, venue information, and FAQ. " +
    "Minimal navigation, strong typography, and a single-occasion focus.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "LANDING_PAGE",
      support: "primary",
      notes: "Event details — couple story, venue, schedule.",
    },
    {
      contentType: "GALLERY",
      support: "primary",
      notes: "Engagement photos, wedding gallery.",
    },
    {
      contentType: "FAQ",
      support: "supported",
      notes: "Guest FAQ — dress code, travel, accommodation.",
    },
    {
      contentType: "BLOG",
      support: "partial",
      notes: "Optional wedding blog or journal.",
    },
    {
      contentType: "ARTICLE",
      support: "partial",
      notes: "Long-form stories or venue write-ups.",
    },
  ],

  supportedLayouts: [
    {
      layout: "LandingLayout",
      usedForPageTypes: ["homepage", "landing"],
      isPrimary: true,
    },
    {
      layout: "GalleryLayout",
      usedForPageTypes: ["gallery"],
      isPrimary: false,
    },
    {
      layout: "MinimalLayout",
      usedForPageTypes: ["not_found", "faq"],
      isPrimary: false,
    },
    {
      layout: "ArticleLayout",
      usedForPageTypes: ["article", "blog"],
      isPrimary: false,
    },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "breadcrumbs",
    "footer-grouped",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Full-bleed hero, couple story, key info." },
    { pageType: "landing",      isRequired: true,  notes: "Venue, schedule, travel, accommodation." },
    { pageType: "gallery",      isRequired: true,  notes: "Engagement and wedding photo galleries." },
    { pageType: "faq",          isRequired: true,  notes: "Guest questions and logistics FAQ." },
    { pageType: "blog",         isRequired: false, notes: "Optional wedding blog." },
    { pageType: "article",      isRequired: false, notes: "Venue write-ups or long-form stories." },
    { pageType: "not_found",    isRequired: true,  notes: "Minimal branded 404 page." },
    { pageType: "sitemap_page", isRequired: false, notes: "HTML sitemap." },
  ],

  requiredComponents: [
    "HeroSection",
    "NavigationBar",
    "GalleryGrid",
    "GalleryLightbox",
    "FAQAccordion",
    "Footer",
  ],

  optionalComponents: [
    "FeaturedContent",
    "LatestContent",
    "ArticleList",
    "ArticleCard",
    "Breadcrumb",
    "RelatedContent",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "landing",
  primaryLayout: "LandingLayout",
  tags: ["wedding", "event", "occasion", "personal", "celebration", "gallery"],
};
