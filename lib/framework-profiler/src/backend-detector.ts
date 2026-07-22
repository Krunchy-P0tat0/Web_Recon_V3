import type { BackendFramework, BackendProfile } from "./types.js";

type Vfs = Record<string, string>;

function nodeDeps(vfs: Vfs): Record<string, string> {
  try {
    const pkg = JSON.parse(vfs["package.json"] ?? vfs["./package.json"] ?? "{}") as Record<string, unknown>;
    return {
      ...((pkg["dependencies"]    as Record<string, string>) ?? {}),
      ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
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
    if (p in vfs)        return vfs[p]!;
    if (`./${p}` in vfs) return vfs[`./${p}`]!;
  }
  return "";
}

// ─── Scorers ──────────────────────────────────────────────────────────────────

function scoreExpress(vfs: Vfs, d: Record<string, string>): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = [];
  let score = 0;

  if ("express" in d) { score += 60; signals.push("express in dependencies"); features.push("rest-api"); }
  if ("cors" in d)    { score += 5; signals.push("cors middleware"); }
  if ("pino" in d || "pino-http" in d) { score += 5; signals.push("pino logger"); }
  const src = fileContent(vfs, "src/index.ts", "src/app.ts", "index.js", "server.js");
  if (src.includes("express()") || src.includes("from 'express'")) { score += 20; signals.push("express() usage in source"); }
  if (src.includes("app.listen") || src.includes("router.")) { score += 10; signals.push("express router/listen pattern"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreNestjs(vfs: Vfs, d: Record<string, string>): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = [];
  let score = 0;

  if ("@nestjs/core" in d)    { score += 70; signals.push("@nestjs/core in dependencies"); features.push("rest-api"); }
  if ("@nestjs/common" in d)  { score += 10; signals.push("@nestjs/common in dependencies"); }
  if (hasFile(vfs, "nest-cli.json")) { score += 15; signals.push("nest-cli.json found"); }
  if (hasFile(vfs, "src/main.ts")) {
    const c = fileContent(vfs, "src/main.ts");
    if (c.includes("NestFactory") || c.includes("@nestjs")) { score += 10; signals.push("NestFactory in src/main.ts"); }
  }
  if ("@nestjs/swagger" in d) { features.push("rest-api"); }
  if ("@nestjs/graphql" in d) { features.push("graphql"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreLaravel(vfs: Vfs): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = ["php-routing", "blade-templates", "eloquent"];
  let score = 0;

  const composer = fileContent(vfs, "composer.json");
  if (composer.includes('"laravel/framework"') || composer.includes("laravel/laravel")) {
    score += 70; signals.push("laravel/framework in composer.json");
  }
  if (hasFile(vfs, "artisan")) { score += 20; signals.push("artisan CLI found"); }
  if (hasFile(vfs, "routes/web.php", "routes/api.php")) { score += 10; signals.push("Laravel routes directory"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreDjango(vfs: Vfs): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = ["rest-api"];
  let score = 0;

  const req = fileContent(vfs, "requirements.txt", "requirements/base.txt", "requirements/prod.txt");
  if (/^django[>=\s]/im.test(req) || req.includes("Django==") || req.includes("django==")) {
    score += 60; signals.push("Django in requirements.txt");
  }
  if (hasFile(vfs, "manage.py")) { score += 25; signals.push("manage.py found"); }
  if (hasFile(vfs, "settings.py", "config/settings.py", "myapp/settings.py")) {
    score += 10; signals.push("Django settings.py found");
  }
  const pipfile = fileContent(vfs, "Pipfile");
  if (pipfile.includes("django") || pipfile.includes("Django")) { score += 5; signals.push("Django in Pipfile"); }

  return { score: Math.min(score, 100), signals, features };
}

function scoreRails(vfs: Vfs): { score: number; signals: string[]; features: string[] } {
  const signals: string[] = [];
  const features: string[] = ["rest-api"];
  let score = 0;

  const gemfile = fileContent(vfs, "Gemfile");
  if (gemfile.includes("gem 'rails'") || gemfile.includes('gem "rails"')) {
    score += 65; signals.push("rails gem in Gemfile");
  }
  if (hasFile(vfs, "config/routes.rb")) { score += 20; signals.push("config/routes.rb found"); }
  if (hasFile(vfs, "Rakefile"))          { score += 10; signals.push("Rakefile found"); }
  if (hasFile(vfs, "config/application.rb")) { score += 5; signals.push("Rails application.rb"); }

  return { score: Math.min(score, 100), signals, features };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function detectBackend(vfs: Vfs): BackendProfile {
  const d = nodeDeps(vfs);

  const scores: Array<{ fw: BackendFramework; score: number; signals: string[]; features: string[] }> = [
    { fw: "nestjs",  ...scoreNestjs(vfs, d) },
    { fw: "express", ...scoreExpress(vfs, d) },
    { fw: "laravel", ...scoreLaravel(vfs) },
    { fw: "django",  ...scoreDjango(vfs) },
    { fw: "rails",   ...scoreRails(vfs) },
  ];

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;

  if (best.score < 15) {
    return { detected: "unknown", version: null, confidence: 0, features: [], signals: ["No backend framework detected"] };
  }

  const versionKeyMap: Record<BackendFramework, string> = {
    express: "express",
    nestjs:  "@nestjs/core",
    laravel: "",
    django:  "",
    rails:   "",
    unknown: "",
  };
  const versionKey = versionKeyMap[best.fw] ?? "";
  const version    = versionKey ? pkgVersion(d, versionKey) : null;

  return {
    detected:   best.fw,
    version,
    confidence: Math.round((best.score / 100) * 100) / 100,
    features:   best.features,
    signals:    best.signals,
  };
}
