import type { FrontendFramework, FrontendProfile } from "./types.js";

type Vfs = Record<string, string>;

function deps(vfs: Vfs): Record<string, string> {
  try {
    const pkg = JSON.parse(vfs["package.json"] ?? vfs["./package.json"] ?? "{}") as Record<string, unknown>;
    return {
      ...((pkg["dependencies"]    as Record<string, string>) ?? {}),
      ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
      ...((pkg["peerDependencies"] as Record<string, string>) ?? {}),
    };
  } catch { return {}; }
}

function pkgVersion(d: Record<string, string>, key: string): string | null {
  return d[key]?.replace(/[^0-9.]/g, "") || null;
}

function hasFile(vfs: Vfs, ...paths: string[]): boolean {
  return paths.some(p => p in vfs || `./${p}` in vfs);
}

function fileContent(vfs: Vfs, ...paths: string[]): string {
  for (const p of paths) {
    if (p in vfs)     return vfs[p]!;
    if (`./${p}` in vfs) return vfs[`./${p}`]!;
  }
  return "";
}

// ─── Individual scorers ───────────────────────────────────────────────────────

function scoreNextjs(vfs: Vfs, d: Record<string, string>): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = [];
  let score = 0;

  if ("next" in d) { score += 70; signals.push("next in dependencies"); }
  if (hasFile(vfs, "next.config.js", "next.config.ts", "next.config.mjs")) { score += 20; signals.push("next.config file found"); }
  if (hasFile(vfs, "app", "app/page.tsx", "app/layout.tsx")) { score += 10; signals.push("Next.js App Router directory"); features.push("app-router"); }
  if (hasFile(vfs, "pages", "pages/index.tsx", "pages/index.js")) { score += 8; signals.push("Next.js pages directory"); features.push("pages-router"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreReact(vfs: Vfs, d: Record<string, string>): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = [];
  let score = 0;

  if ("react" in d) { score += 30; signals.push("react in dependencies"); }
  if ("react-dom" in d) { score += 15; signals.push("react-dom in dependencies"); }
  if (hasFile(vfs, "vite.config.ts", "vite.config.js")) {
    const c = fileContent(vfs, "vite.config.ts", "vite.config.js");
    if (c.includes("@vitejs/plugin-react") || c.includes("plugin-react")) {
      score += 20; signals.push("Vite React plugin detected"); features.push("vite");
    }
  }
  if (hasFile(vfs, "src/App.tsx", "src/App.jsx", "src/app.tsx")) { score += 10; signals.push("src/App.tsx found"); }
  if (hasFile(vfs, "public/index.html")) { score += 5; signals.push("CRA-style index.html"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreAstro(vfs: Vfs, d: Record<string, string>): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = [];
  let score = 0;

  if ("astro" in d) { score += 70; signals.push("astro in dependencies"); }
  if (hasFile(vfs, "astro.config.mjs", "astro.config.ts", "astro.config.js")) { score += 20; signals.push("astro.config found"); }
  if (hasFile(vfs, "src/pages", "src/layouts")) { score += 10; signals.push("Astro pages/layouts dir"); features.push("file-system-routing"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreVue(vfs: Vfs, d: Record<string, string>): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = [];
  let score = 0;

  if ("vue" in d) { score += 60; signals.push("vue in dependencies"); }
  if ("@vue/cli-service" in d || "@vue/compiler-sfc" in d) { score += 15; signals.push("Vue CLI / compiler detected"); }
  if (hasFile(vfs, "vue.config.js", "vue.config.ts")) { score += 15; signals.push("vue.config found"); }
  if (hasFile(vfs, "vite.config.ts", "vite.config.js")) {
    const c = fileContent(vfs, "vite.config.ts", "vite.config.js");
    if (c.includes("@vitejs/plugin-vue") || c.includes("plugin-vue")) {
      score += 10; signals.push("Vite Vue plugin detected"); features.push("vite");
    }
  }
  if (hasFile(vfs, "nuxt.config.ts", "nuxt.config.js")) { score += 20; signals.push("Nuxt.js config detected"); features.push("ssr"); }
  const lockfile = fileContent(vfs, "pnpm-lock.yaml", "yarn.lock", "package-lock.json");
  if (lockfile.includes("vue@")) { score += 5; signals.push("vue in lockfile"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreAngular(vfs: Vfs, d: Record<string, string>): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = [];
  let score = 0;

  if ("@angular/core" in d) { score += 70; signals.push("@angular/core in dependencies"); features.push("angular-core"); }
  if ("@angular/cli" in d)  { score += 10; signals.push("@angular/cli detected"); }
  if (hasFile(vfs, "angular.json")) { score += 20; signals.push("angular.json found"); }
  if (hasFile(vfs, "ng-package.json")) { score += 5; signals.push("ng-package.json found"); }
  if (hasFile(vfs, "src/main.ts")) { score += 5; signals.push("Angular entry src/main.ts"); features.push("typescript"); }

  return { score: Math.min(score, 100), signals, features };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function detectFrontend(vfs: Vfs): FrontendProfile {
  const d = deps(vfs);

  const scores: Array<{ fw: FrontendFramework; score: number; signals: string[]; features: string[] }> = [
    { fw: "nextjs",  ...scoreNextjs(vfs, d) },
    { fw: "astro",   ...scoreAstro(vfs, d) },
    { fw: "vue",     ...scoreVue(vfs, d) },
    { fw: "angular", ...scoreAngular(vfs, d) },
    { fw: "react",   ...scoreReact(vfs, d) },
  ];

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;

  if (best.score < 15) {
    return { detected: "unknown", version: null, confidence: 0, features: [], signals: ["No frontend framework detected"] };
  }

  const versionMap: Record<FrontendFramework, string> = {
    nextjs:  "next",
    react:   "react",
    astro:   "astro",
    vue:     "vue",
    angular: "@angular/core",
    unknown: "",
  };
  const versionKey = versionMap[best.fw] ?? "";
  const version    = versionKey ? pkgVersion(d, versionKey) : null;
  const confidence = Math.round((best.score / 100) * 100) / 100;

  return {
    detected:   best.fw,
    version,
    confidence,
    features:   best.features,
    signals:    best.signals,
  };
}
