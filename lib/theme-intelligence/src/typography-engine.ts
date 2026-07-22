/**
 * typography-engine.ts — Derives typography system from site classification
 *
 * Maps site type + design strategy to font families, type scales, and spacing.
 * Font choices are categorized by class (elegant-serif, modern-sans, etc.)
 * and include Google Fonts URLs for runtime loading.
 */

import type { SiteType, DesignStrategy, FontDefinition, FontClass, TypeScale, TypeScaleStep, TypographySystem } from "./types";
import type { SiteClassification } from "./types";

// ---------------------------------------------------------------------------
// Font library
// ---------------------------------------------------------------------------

const FONTS: Record<string, FontDefinition> = {
  "playfair-display": {
    family: "Playfair Display",
    fallback: "Georgia, 'Times New Roman', serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600&display=swap",
    fontClass: "elegant-serif",
    weights: [400, 500, 600, 700],
    styles: ["normal", "italic"],
  },
  "cormorant-garamond": {
    family: "Cormorant Garamond",
    fallback: "Georgia, serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap",
    fontClass: "elegant-serif",
    weights: [300, 400, 600],
    styles: ["normal", "italic"],
  },
  "merriweather": {
    family: "Merriweather",
    fallback: "'Georgia', serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,300;0,400;0,700;1,300;1,400&display=swap",
    fontClass: "editorial-serif",
    weights: [300, 400, 700],
    styles: ["normal", "italic"],
  },
  "lora": {
    family: "Lora",
    fallback: "Georgia, serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap",
    fontClass: "readable-serif",
    weights: [400, 500, 600],
    styles: ["normal", "italic"],
  },
  "inter": {
    family: "Inter",
    fallback: "system-ui, -apple-system, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap",
    fontClass: "humanist-sans",
    weights: [300, 400, 500, 600, 700, 800],
    styles: ["normal"],
  },
  "dm-sans": {
    family: "DM Sans",
    fallback: "system-ui, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap",
    fontClass: "geometric-sans",
    weights: [300, 400, 500, 600, 700],
    styles: ["normal", "italic"],
  },
  "space-grotesk": {
    family: "Space Grotesk",
    fallback: "system-ui, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap",
    fontClass: "geometric-sans",
    weights: [300, 400, 500, 600, 700],
    styles: ["normal"],
  },
  "raleway": {
    family: "Raleway",
    fallback: "system-ui, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Raleway:ital,wght@0,300;0,400;0,500;0,700;0,800;1,400&display=swap",
    fontClass: "geometric-sans",
    weights: [300, 400, 500, 700, 800],
    styles: ["normal", "italic"],
  },
  "source-serif": {
    family: "Source Serif 4",
    fallback: "Georgia, serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,300;0,400;0,600;0,700;1,400&display=swap",
    fontClass: "editorial-serif",
    weights: [300, 400, 600, 700],
    styles: ["normal", "italic"],
  },
  "nunito": {
    family: "Nunito",
    fallback: "system-ui, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,300;0,400;0,600;0,700;1,400&display=swap",
    fontClass: "humanist-sans",
    weights: [300, 400, 600, 700],
    styles: ["normal", "italic"],
  },
  "jost": {
    family: "Jost",
    fallback: "system-ui, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&display=swap",
    fontClass: "geometric-sans",
    weights: [300, 400, 500, 600],
    styles: ["normal", "italic"],
  },
  "libre-baskerville": {
    family: "Libre Baskerville",
    fallback: "Georgia, serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap",
    fontClass: "readable-serif",
    weights: [400, 700],
    styles: ["normal", "italic"],
  },
  "franklin-gothic": {
    family: "Barlow Condensed",
    fallback: "'Arial Narrow', Arial, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap",
    fontClass: "condensed-sans",
    weights: [400, 600, 700, 800],
    styles: ["normal", "italic"],
  },
  "roboto": {
    family: "Roboto",
    fallback: "system-ui, sans-serif",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;1,400&display=swap",
    fontClass: "humanist-sans",
    weights: [300, 400, 500, 700],
    styles: ["normal", "italic"],
  },
  "fira-code": {
    family: "Fira Code",
    fallback: "'Courier New', Courier, monospace",
    googleFontUrl: "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&display=swap",
    fontClass: "mono",
    weights: [400, 500],
    styles: ["normal"],
  },
};

// ---------------------------------------------------------------------------
// Typography profiles per site type
// ---------------------------------------------------------------------------

interface TypographyProfile {
  headingKey: string;
  bodyKey: string;
  displayKey: string;
  scale: TypeScale;
  baseFontSize: string;
  baseLineHeight: string;
  paragraphSpacing: string;
  headingTracking: string;
  reasoning: string;
}

const TYPOGRAPHY_PROFILES: Record<SiteType, TypographyProfile> = {
  editorial: {
    headingKey: "playfair-display",
    bodyKey: "merriweather",
    displayKey: "playfair-display",
    scale: "editorial",
    baseFontSize: "18px",
    baseLineHeight: "1.75",
    paragraphSpacing: "1.5em",
    headingTracking: "-0.02em",
    reasoning: "Editorial typography: Playfair Display headings for gravitas, Merriweather body for long-form readability.",
  },
  news: {
    headingKey: "franklin-gothic",
    bodyKey: "source-serif",
    displayKey: "franklin-gothic",
    scale: "compact",
    baseFontSize: "16px",
    baseLineHeight: "1.6",
    paragraphSpacing: "1em",
    headingTracking: "-0.01em",
    reasoning: "News typography: condensed sans headlines for density, Source Serif body for comfortable reading at speed.",
  },
  corporate: {
    headingKey: "inter",
    bodyKey: "inter",
    displayKey: "inter",
    scale: "default",
    baseFontSize: "16px",
    baseLineHeight: "1.65",
    paragraphSpacing: "1.25em",
    headingTracking: "-0.025em",
    reasoning: "Corporate typography: Inter throughout for professional consistency and cross-platform legibility.",
  },
  portfolio: {
    headingKey: "space-grotesk",
    bodyKey: "dm-sans",
    displayKey: "space-grotesk",
    scale: "generous",
    baseFontSize: "16px",
    baseLineHeight: "1.7",
    paragraphSpacing: "1.5em",
    headingTracking: "-0.03em",
    reasoning: "Portfolio typography: Space Grotesk for distinctive character, DM Sans body for clean showcase layouts.",
  },
  wedding: {
    headingKey: "cormorant-garamond",
    bodyKey: "lora",
    displayKey: "cormorant-garamond",
    scale: "generous",
    baseFontSize: "17px",
    baseLineHeight: "1.8",
    paragraphSpacing: "1.5em",
    headingTracking: "0.05em",
    reasoning: "Wedding typography: Cormorant Garamond for romantic elegance, Lora body with generous spacing for ceremony.",
  },
  luxury: {
    headingKey: "cormorant-garamond",
    bodyKey: "jost",
    displayKey: "playfair-display",
    scale: "generous",
    baseFontSize: "16px",
    baseLineHeight: "1.85",
    paragraphSpacing: "1.75em",
    headingTracking: "0.08em",
    reasoning: "Luxury typography: Cormorant Garamond with wide tracking for exclusivity, Jost body for modern contrast.",
  },
  lifestyle: {
    headingKey: "jost",
    bodyKey: "libre-baskerville",
    displayKey: "playfair-display",
    scale: "default",
    baseFontSize: "17px",
    baseLineHeight: "1.75",
    paragraphSpacing: "1.4em",
    headingTracking: "-0.01em",
    reasoning: "Lifestyle typography: Jost headings for warmth, Libre Baskerville body for an approachable editorial feel.",
  },
  travel: {
    headingKey: "raleway",
    bodyKey: "lora",
    displayKey: "raleway",
    scale: "editorial",
    baseFontSize: "17px",
    baseLineHeight: "1.75",
    paragraphSpacing: "1.4em",
    headingTracking: "0.02em",
    reasoning: "Travel typography: Raleway display for adventurous spirit, Lora body for immersive storytelling.",
  },
  photography: {
    headingKey: "inter",
    bodyKey: "inter",
    displayKey: "inter",
    scale: "compact",
    baseFontSize: "14px",
    baseLineHeight: "1.5",
    paragraphSpacing: "1em",
    headingTracking: "0.1em",
    reasoning: "Photography typography: minimal Inter with sparse use — UI must not compete with images.",
  },
  blog: {
    headingKey: "nunito",
    bodyKey: "lora",
    displayKey: "nunito",
    scale: "default",
    baseFontSize: "17px",
    baseLineHeight: "1.75",
    paragraphSpacing: "1.4em",
    headingTracking: "-0.01em",
    reasoning: "Blog typography: Nunito for friendly headings, Lora body for pleasant long-form reading.",
  },
  marketplace: {
    headingKey: "inter",
    bodyKey: "roboto",
    displayKey: "inter",
    scale: "compact",
    baseFontSize: "15px",
    baseLineHeight: "1.55",
    paragraphSpacing: "1em",
    headingTracking: "-0.02em",
    reasoning: "Marketplace typography: high-legibility Inter/Roboto stack optimized for scanning product listings.",
  },
  documentation: {
    headingKey: "inter",
    bodyKey: "source-serif",
    displayKey: "inter",
    scale: "default",
    baseFontSize: "16px",
    baseLineHeight: "1.7",
    paragraphSpacing: "1.3em",
    headingTracking: "-0.015em",
    reasoning: "Documentation typography: Inter headings for structure clarity, Source Serif body for extended reading sessions.",
  },
  unknown: {
    headingKey: "inter",
    bodyKey: "inter",
    displayKey: "inter",
    scale: "default",
    baseFontSize: "16px",
    baseLineHeight: "1.65",
    paragraphSpacing: "1.25em",
    headingTracking: "-0.02em",
    reasoning: "Default typography: Inter system font stack applied when site type is undetermined.",
  },
};

// ---------------------------------------------------------------------------
// Type scale steps generator
// ---------------------------------------------------------------------------

function buildScaleSteps(scale: TypeScale): TypeScaleStep[] {
  const ratios: Record<TypeScale, number> = {
    compact:   1.2,
    default:   1.25,
    generous:  1.333,
    editorial: 1.414,
  };
  const ratio = ratios[scale];
  const base  = 16;

  const steps: Array<{ name: string; multiplier: number; weight: number; useCase: string }> = [
    { name: "xs",    multiplier: Math.pow(ratio, -2), weight: 400, useCase: "captions, legal text, metadata" },
    { name: "sm",    multiplier: Math.pow(ratio, -1), weight: 400, useCase: "secondary text, labels" },
    { name: "base",  multiplier: 1,                   weight: 400, useCase: "body text, paragraphs" },
    { name: "lg",    multiplier: ratio,               weight: 500, useCase: "lead text, card titles" },
    { name: "xl",    multiplier: Math.pow(ratio, 2),  weight: 600, useCase: "section headings, h3" },
    { name: "2xl",   multiplier: Math.pow(ratio, 3),  weight: 600, useCase: "page headings, h2" },
    { name: "3xl",   multiplier: Math.pow(ratio, 4),  weight: 700, useCase: "major headings, h1" },
    { name: "4xl",   multiplier: Math.pow(ratio, 5),  weight: 700, useCase: "hero headings, display" },
    { name: "5xl",   multiplier: Math.pow(ratio, 6),  weight: 800, useCase: "billboard, splash text" },
  ];

  return steps.map(s => ({
    name:          s.name,
    size:          `${(base * s.multiplier).toFixed(3)}px`,
    lineHeight:    s.multiplier >= 3 ? "1.1" : s.multiplier >= 2 ? "1.2" : s.multiplier >= 1.5 ? "1.3" : "1.5",
    letterSpacing: s.multiplier >= 4 ? "-0.03em" : s.multiplier >= 2 ? "-0.02em" : "0em",
    fontWeight:    s.weight,
    useCase:       s.useCase,
  }));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveTypographySystem(classification: SiteClassification): TypographySystem {
  const profile = TYPOGRAPHY_PROFILES[classification.primary] ?? TYPOGRAPHY_PROFILES["unknown"];

  const headingFont = FONTS[profile.headingKey] ?? FONTS["inter"];
  const bodyFont    = FONTS[profile.bodyKey]    ?? FONTS["inter"];
  const displayFont = FONTS[profile.displayKey] ?? FONTS["inter"];
  const monoFont    = FONTS["fira-code"];

  return {
    headingFont,
    bodyFont,
    displayFont,
    monoFont,
    scale:            profile.scale,
    scaleSteps:       buildScaleSteps(profile.scale),
    baseFontSize:     profile.baseFontSize,
    baseLineHeight:   profile.baseLineHeight,
    paragraphSpacing: profile.paragraphSpacing,
    headingTracking:  profile.headingTracking,
    derivationReasoning: profile.reasoning,
  };
}
