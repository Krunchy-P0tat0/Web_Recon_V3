/**
 * @workspace/design-dna
 *
 * Design DNA — Phase 4.1 + 4.2 + 4.3
 *
 * Exports:
 *   types      — TypeScript interfaces for the design-dna.json shape
 *   schema     — Zod validators + validateDesignDNA()
 *   serializer — serializeDesignDNA / deserializeDesignDNA
 *   storage    — DesignDNAStore interface + save/load/delete helpers
 *   extractor  — extractDesignDNA() + extractDesignDNAWithEvidence()
 *   audit      — generateAuditReport()
 *   classifier — classifyDesign() + generateClassificationReport()
 */

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  DesignDNA,
  DesignDNAMeta,
  TypographyDNA,
  FontEntry,
  FontRole,
  FontClass,
  TypeScaleStep,
  TypeScale,
  ColorDNA,
  ColorSwatch,
  ColorScale,
  SemanticColorMap,
  SpacingDNA,
  SpacingDensity,
  SpacingScale,
  BorderDNA,
  RadiusTokens,
  ShadowTokens,
  NavigationDNA,
  NavPosition,
  NavBackground,
  NavMobileStyle,
  HeroDNA,
  HeroLayout,
  CtaStyle,
  CardDNA,
  CardLayout,
  CardImagePosition,
  CardHoverEffect,
  GalleryDNA,
  GalleryLayout,
  GalleryAspectRatio,
  LayoutDNA,
  LayoutStrategy,
  GridSystem,
  SectionDivider,
  HeroHeight,
  SectionSpacing,
} from "./types";

// ─── Schema (Zod validators) ──────────────────────────────────────────────────
export {
  DesignDNASchema,
  DesignDNAMetaSchema,
  TypographyDNASchema,
  ColorDNASchema,
  SpacingDNASchema,
  BorderDNASchema,
  NavigationDNASchema,
  HeroDNASchema,
  CardDNASchema,
  GalleryDNASchema,
  LayoutDNASchema,
  validateDesignDNA,
} from "./schema";
export type { ValidationResult } from "./schema";

// ─── Serializer ───────────────────────────────────────────────────────────────
export { serializeDesignDNA, deserializeDesignDNA } from "./serializer";
export type { DeserializeResult } from "./serializer";

// ─── Storage ──────────────────────────────────────────────────────────────────
export {
  designDnaKey,
  saveDesignDNA,
  loadDesignDNA,
  deleteDesignDNA,
} from "./storage";
export type {
  DesignDNAStore,
  DesignDNAStoreWithDelete,
  SaveDesignDNAResult,
  LoadDesignDNAResult,
  DeleteDesignDNAResult,
} from "./storage";

// ─── Extractor ────────────────────────────────────────────────────────────────
export { extractDesignDNA, extractDesignDNAWithEvidence } from "./extractor";
export type {
  PageInput,
  ExtractionInput,
  ExtractionResult,
  SignalEvidence,
} from "./extractor";

// ─── Audit ────────────────────────────────────────────────────────────────────
export { generateAuditReport } from "./audit";
export type {
  AuditReport,
  AuditSection,
  AuditSignal,
  AuditSummary,
  Confidence,
} from "./audit";

// ─── Classifier (Phase 4.3) ───────────────────────────────────────────────────
export { classifyDesign, generateClassificationReport } from "./classifier";
export type { ClassificationReport } from "./classifier";
export type {
  DesignArchetype,
  ArchetypeScore,
  DesignProfile,
} from "./types";
