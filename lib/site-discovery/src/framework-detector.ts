import type {
  Framework,
  FrameworkDetectionResult,
  FrameworkFeature,
  PackageManager,
  VirtualFileSystem,
} from "./types.js";

interface FrameworkScore {
  framework: Framework;
  score: number;
  version: string | null;
}

function parsePkg(vfs: VirtualFileSystem): Record<string, unknown> {
  const raw = vfs["package.json"] ?? vfs["./package.json"];
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseComposer(vfs: VirtualFileSystem): Record<string, unknown> {
  const raw = vfs["composer.json"] ?? vfs["./composer.json"];
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function allDeps(pkg: Record<string, unknown>): Record<string, string> {
  return {
    ...((pkg["dependencies"] as Record<string, string>) ?? {}),
    ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
    ...((pkg["peerDependencies"] as Record<string, string>) ?? {}),
  };
}

function hasFile(vfs: VirtualFileSystem, ...paths: string[]): boolean {
  return paths.some((p) => p in vfs || `./${p}` in vfs);
}

function hasDir(vfs: VirtualFileSystem, dirPrefix: string): boolean {
  const prefix = dirPrefix.endsWith("/") ? dirPrefix : `${dirPrefix}/`;
  return Object.keys(vfs).some(
    (k) => k.startsWith(prefix) || k.startsWith(`./${prefix}`)
  );
}

function anyFileMatches(vfs: VirtualFileSystem, regex: RegExp): boolean {
  return Object.keys(vfs).some((k) => regex.test(k));
}

function contentOf(vfs: VirtualFileSystem, ...paths: string[]): string {
  for (const p of paths) {
    if (p in vfs) return vfs[p]!;
    if (`./${p}` in vfs) return vfs[`./${p}`]!;
  }
  return "";
}

// ─── Scorer ──────────────────────────────────────────────────────────────────

function scoreNextjs(vfs: VirtualFileSystem, pkg: Record<string, unknown>): FrameworkScore {
  const deps = allDeps(pkg);
  let score = 0;
  let version: string | null = null;

  if ("next" in deps) {
    score += 60;
    version = (deps["next"] ?? null) as string | null;
  }

  const configFiles = [
    "next.config.js",
    "next.config.ts",
    "next.config.mjs",
    "next.config.cjs",
  ];
  if (hasFile(vfs, ...configFiles)) score += 20;
  if (hasDir(vfs, "app") && anyFileMatches(vfs, /\/page\.(tsx?|jsx?)$/)) score += 15;
  if (hasDir(vfs, "pages")) score += 10;
  if (hasFile(vfs, "pages/_app.tsx", "pages/_app.js", "pages/_app.ts")) score += 10;

  return { framework: "nextjs", score, version };
}

function scoreReact(vfs: VirtualFileSystem, pkg: Record<string, unknown>): FrameworkScore {
  const deps = allDeps(pkg);
  let score = 0;

  if ("react" in deps && "react-dom" in deps) score += 30;
  if ("@vitejs/plugin-react" in deps || "@vitejs/plugin-react-swc" in deps) score += 20;
  if (hasFile(vfs, "vite.config.ts", "vite.config.js", "vite.config.mts")) score += 10;
  if (anyFileMatches(vfs, /\.(tsx|jsx)$/)) score += 10;
  if (hasFile(vfs, "src/App.tsx", "src/App.jsx", "src/main.tsx", "src/main.jsx")) score += 10;

  return { framework: "react", score, version: (deps["react"] ?? null) as string | null };
}

function scoreAstro(vfs: VirtualFileSystem, pkg: Record<string, unknown>): FrameworkScore {
  const deps = allDeps(pkg);
  let score = 0;
  let version: string | null = null;

  if ("astro" in deps) {
    score += 60;
    version = (deps["astro"] ?? null) as string | null;
  }
  const configFiles = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];
  if (hasFile(vfs, ...configFiles)) score += 20;
  if (anyFileMatches(vfs, /\.astro$/)) score += 15;
  if (hasDir(vfs, "src/pages")) score += 5;

  return { framework: "astro", score, version };
}

function scoreExpress(vfs: VirtualFileSystem, pkg: Record<string, unknown>): FrameworkScore {
  const deps = allDeps(pkg);
  let score = 0;

  if ("express" in deps) score += 50;
  const serverFiles = ["server.ts", "server.js", "app.ts", "app.js", "index.ts", "index.js"];
  for (const f of serverFiles) {
    const c = contentOf(vfs, f, `src/${f}`);
    if (c.includes("express()") || c.includes("require('express')") || c.includes('require("express")')) {
      score += 20;
      break;
    }
  }
  if (hasDir(vfs, "routes") || hasDir(vfs, "src/routes")) score += 10;

  return { framework: "express", score, version: (deps["express"] ?? null) as string | null };
}

function scoreLaravel(vfs: VirtualFileSystem): FrameworkScore {
  const composer = parseComposer(vfs);
  const require = (composer["require"] as Record<string, string>) ?? {};
  let score = 0;

  if ("laravel/framework" in require) {
    score += 70;
  }
  if (hasFile(vfs, "artisan")) score += 20;
  if (hasFile(vfs, "routes/web.php")) score += 15;
  if (hasDir(vfs, "app/Http/Controllers")) score += 10;
  if (hasDir(vfs, "resources/views")) score += 10;

  const version = (require["laravel/framework"] ?? null) as string | null;
  return { framework: "laravel", score, version };
}

function scoreWordPress(vfs: VirtualFileSystem): FrameworkScore {
  let score = 0;

  if (hasFile(vfs, "wp-config.php", "wp-config-sample.php")) score += 60;
  if (hasFile(vfs, "wp-login.php")) score += 30;
  if (hasFile(vfs, "functions.php")) {
    const c = contentOf(vfs, "functions.php");
    if (c.includes("add_action") || c.includes("add_filter") || c.includes("wp_enqueue")) score += 20;
  }
  const style = contentOf(vfs, "style.css");
  if (style.includes("Theme Name:")) score += 20;
  if (hasDir(vfs, "wp-content") || hasDir(vfs, "wp-admin")) score += 30;

  return { framework: "wordpress", score, version: null };
}

// ─── Feature detection ────────────────────────────────────────────────────────

function detectFeatures(
  primary: Framework,
  vfs: VirtualFileSystem,
  pkg: Record<string, unknown>
): FrameworkFeature[] {
  const features: FrameworkFeature[] = [];
  const deps = allDeps(pkg);

  if (primary === "nextjs") {
    const hasApp = hasDir(vfs, "app") && anyFileMatches(vfs, /\/page\.(tsx?|jsx?)$/);
    const hasPages = hasDir(vfs, "pages");

    if (hasApp) {
      features.push("app-router", "layouts", "react-server-components");
      if (anyFileMatches(vfs, /\/(loading|error|not-found)\.(tsx?|jsx?)$/)) {
        features.push("loading-states", "error-boundaries");
      }
    }
    if (hasPages) {
      features.push("pages-router");
    }
    if (hasDir(vfs, "pages/api") || anyFileMatches(vfs, /\/app\/api\//)) {
      features.push("api-routes");
    }
    if (hasFile(vfs, "middleware.ts", "middleware.js")) {
      features.push("middleware");
    }
    if (anyFileMatches(vfs, /\[\.{3}/)) features.push("catch-all-routes");
    if (anyFileMatches(vfs, /\[\[\.{3}/)) features.push("optional-catch-all-routes");
    if (anyFileMatches(vfs, /\[/)) features.push("dynamic-routes");
    features.push("file-system-routing", "ssr", "ssg");
  }

  if (primary === "astro") {
    features.push("file-system-routing", "ssg");
    if (anyFileMatches(vfs, /\[.*\].*\.astro$/)) features.push("dynamic-routes");
    const astroConfig = contentOf(vfs, "astro.config.mjs", "astro.config.ts");
    if (astroConfig.includes("ssr") || astroConfig.includes("server")) features.push("ssr");
    if (anyFileMatches(vfs, /\.mdx?$/)) features.push("mdx");
    if (hasDir(vfs, "src/content")) features.push("content-collections");
  }

  if (primary === "express") {
    features.push("rest-api");
    if ("graphql" in deps || "@apollo/server" in deps) features.push("graphql");
    if ("@trpc/server" in deps) features.push("trpc");
  }

  if (primary === "laravel") {
    features.push("php-routing", "blade-templates", "eloquent", "rest-api");
    if (hasFile(vfs, "routes/api.php")) features.push("api-routes");
  }

  if (primary === "wordpress") {
    features.push("wp-hooks", "wp-rest-api");
    const fns = contentOf(vfs, "functions.php");
    if (fns.includes("add_shortcode")) features.push("wp-shortcodes");
  }

  return [...new Set(features)];
}

// ─── Package manager ──────────────────────────────────────────────────────────

function detectPackageManager(vfs: VirtualFileSystem): PackageManager {
  if (hasFile(vfs, "bun.lockb", "bun.lock")) return "bun";
  if (hasFile(vfs, "pnpm-lock.yaml")) return "pnpm";
  if (hasFile(vfs, "yarn.lock")) return "yarn";
  if (hasFile(vfs, "package-lock.json")) return "npm";
  if (hasFile(vfs, "composer.lock")) return "composer";
  return "unknown";
}

// ─── Monorepo detection ───────────────────────────────────────────────────────

function detectMonorepo(vfs: VirtualFileSystem, pkg: Record<string, unknown>): boolean {
  if ("workspaces" in pkg) return true;
  if (hasFile(vfs, "pnpm-workspace.yaml")) return true;
  if (hasFile(vfs, "lerna.json")) return true;
  if (hasFile(vfs, "nx.json", "turbo.json")) return true;
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectFramework(vfs: VirtualFileSystem): FrameworkDetectionResult {
  const pkg = parsePkg(vfs);

  const scores: FrameworkScore[] = [
    scoreNextjs(vfs, pkg),
    scoreReact(vfs, pkg),
    scoreAstro(vfs, pkg),
    scoreExpress(vfs, pkg),
    scoreLaravel(vfs),
    scoreWordPress(vfs),
  ].sort((a, b) => b.score - a.score);

  const top = scores[0]!;
  const primary: Framework = top.score >= 20 ? top.framework : "unknown";
  const secondary = scores
    .slice(1)
    .filter((s) => s.score >= 20 && s.framework !== primary)
    .map((s) => s.framework);

  const maxPossible: Record<Framework, number> = {
    nextjs: 115,
    react: 80,
    astro: 100,
    express: 80,
    laravel: 125,
    wordpress: 160,
    unknown: 1,
  };

  const confidence = primary === "unknown"
    ? 0
    : Math.min(1, top.score / (maxPossible[primary] ?? 100));

  const features = detectFeatures(primary, vfs, pkg);

  return {
    primary,
    secondary,
    confidence: parseFloat(confidence.toFixed(3)),
    version: top.version,
    features,
    isMonorepo: detectMonorepo(vfs, pkg),
    packageManager: detectPackageManager(vfs),
  };
}
