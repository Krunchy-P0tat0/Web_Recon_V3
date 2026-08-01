import type {
  DataSourceKind,
  DataSourceProvider,
  DiscoveredDataSource,
  VirtualFileSystem,
} from "./types.js";

let dsSeq = 0;
function nextId(): string {
  return `ds-${(++dsSeq).toString().padStart(4, "0")}`;
}

// ─── Provider registry ────────────────────────────────────────────────────────

interface ProviderSignature {
  provider: DataSourceProvider;
  kind: DataSourceKind;
  pkgNames: string[];
  filePatterns: RegExp[];
  contentPatterns: RegExp[];
  envVarPrefixes: string[];
  schemaPatterns: RegExp[];
}

const PROVIDERS: ProviderSignature[] = [
  {
    provider: "prisma",
    kind: "database",
    pkgNames: ["@prisma/client", "prisma"],
    filePatterns: [/prisma\/schema\.prisma$/, /schema\.prisma$/],
    contentPatterns: [/from ['"]@prisma\/client['"]/, /PrismaClient/],
    envVarPrefixes: ["DATABASE_URL"],
    schemaPatterns: [/prisma\/schema\.prisma$/],
  },
  {
    provider: "drizzle",
    kind: "database",
    pkgNames: ["drizzle-orm", "drizzle-kit"],
    filePatterns: [/drizzle\.config\.(ts|js)$/, /schema\.(ts|js)$/],
    contentPatterns: [/from ['"]drizzle-orm['"]/, /drizzle\(/],
    envVarPrefixes: ["DATABASE_URL", "DB_URL"],
    schemaPatterns: [/schema\.(ts|js)$/],
  },
  {
    provider: "mongoose",
    kind: "database",
    pkgNames: ["mongoose"],
    filePatterns: [/models\/.*\.ts$/, /models\/.*\.js$/],
    contentPatterns: [/from ['"]mongoose['"]/, /mongoose\.connect/, /new Schema/],
    envVarPrefixes: ["MONGODB_URI", "MONGO_URI"],
    schemaPatterns: [/models\//],
  },
  {
    provider: "sequelize",
    kind: "database",
    pkgNames: ["sequelize"],
    filePatterns: [/models\/index\.[tj]s$/],
    contentPatterns: [/from ['"]sequelize['"]/, /new Sequelize/],
    envVarPrefixes: ["DATABASE_URL", "DB_URI"],
    schemaPatterns: [],
  },
  {
    provider: "typeorm",
    kind: "database",
    pkgNames: ["typeorm"],
    filePatterns: [/ormconfig\.(json|ts|js)$/, /data-source\.[tj]s$/],
    contentPatterns: [/from ['"]typeorm['"]/, /createConnection/, /DataSource/],
    envVarPrefixes: ["DATABASE_URL", "TYPEORM_"],
    schemaPatterns: [],
  },
  {
    provider: "supabase",
    kind: "database",
    pkgNames: ["@supabase/supabase-js", "@supabase/ssr", "@supabase/auth-helpers-nextjs"],
    filePatterns: [/supabase\//],
    contentPatterns: [/createClient\(/, /supabase\.from\(/],
    envVarPrefixes: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_"],
    schemaPatterns: [],
  },
  {
    provider: "firebase",
    kind: "database",
    pkgNames: ["firebase", "firebase-admin"],
    filePatterns: [/firebase\//],
    contentPatterns: [/initializeApp/, /getFirestore/, /getAuth/],
    envVarPrefixes: ["FIREBASE_", "NEXT_PUBLIC_FIREBASE_"],
    schemaPatterns: [],
  },
  {
    provider: "contentful",
    kind: "cms",
    pkgNames: ["contentful", "@contentful/rich-text-react-renderer"],
    filePatterns: [],
    contentPatterns: [/from ['"]contentful['"]/, /createClient\(.*space/i],
    envVarPrefixes: ["CONTENTFUL_SPACE_ID", "CONTENTFUL_"],
    schemaPatterns: [],
  },
  {
    provider: "sanity",
    kind: "cms",
    pkgNames: ["@sanity/client", "next-sanity", "sanity"],
    filePatterns: [/sanity\.config\.(ts|js)$/, /studio\//],
    contentPatterns: [/createClient\(.*projectId/i, /sanity\(/, /groq`/],
    envVarPrefixes: ["NEXT_PUBLIC_SANITY_PROJECT_ID", "SANITY_"],
    schemaPatterns: [/sanity\/schemas\//],
  },
  {
    provider: "strapi",
    kind: "cms",
    pkgNames: ["@strapi/strapi"],
    filePatterns: [/config\/database\.[tj]s$/],
    contentPatterns: [/strapi\.query/, /strapi\.entityService/],
    envVarPrefixes: ["STRAPI_API_URL", "STRAPI_"],
    schemaPatterns: [],
  },
  {
    provider: "ghost",
    kind: "cms",
    pkgNames: ["@tryghost/content-api"],
    filePatterns: [],
    contentPatterns: [/GhostContentAPI/, /from ['"]@tryghost/],
    envVarPrefixes: ["GHOST_API_URL", "GHOST_"],
    schemaPatterns: [],
  },
  {
    provider: "prismic",
    kind: "cms",
    pkgNames: ["@prismicio/client", "@prismicio/next"],
    filePatterns: [/prismicio\.[tj]s$/],
    contentPatterns: [/createClient\(.*endpoint/i, /from ['"]@prismicio/],
    envVarPrefixes: ["PRISMIC_ACCESS_TOKEN"],
    schemaPatterns: [],
  },
  {
    provider: "payload",
    kind: "cms",
    pkgNames: ["payload"],
    filePatterns: [/payload\.config\.[tj]s$/],
    contentPatterns: [/buildConfig/, /from ['"]payload/],
    envVarPrefixes: ["PAYLOAD_SECRET", "DATABASE_URI"],
    schemaPatterns: [],
  },
  {
    provider: "clerk",
    kind: "auth",
    pkgNames: ["@clerk/nextjs", "@clerk/clerk-sdk-node", "@clerk/clerk-react"],
    filePatterns: [],
    contentPatterns: [/ClerkProvider/, /currentUser\(\)/, /auth\(\).*clerk/i],
    envVarPrefixes: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"],
    schemaPatterns: [],
  },
  {
    provider: "next-auth",
    kind: "auth",
    pkgNames: ["next-auth", "@auth/core"],
    filePatterns: [/auth\.[tj]s$/, /\[...nextauth\]/],
    contentPatterns: [/NextAuth/, /getServerSession/, /authOptions/],
    envVarPrefixes: ["NEXTAUTH_SECRET", "NEXTAUTH_URL", "AUTH_"],
    schemaPatterns: [],
  },
  {
    provider: "passport",
    kind: "auth",
    pkgNames: ["passport", "passport-local", "passport-jwt"],
    filePatterns: [],
    contentPatterns: [/passport\.use/, /passport\.authenticate/],
    envVarPrefixes: ["JWT_SECRET", "SESSION_SECRET"],
    schemaPatterns: [],
  },
  {
    provider: "redis",
    kind: "cache",
    pkgNames: ["ioredis", "redis", "@upstash/redis"],
    filePatterns: [],
    contentPatterns: [/new Redis\(/, /createClient\(.*redis/i, /\.set\(.*\.get\(/],
    envVarPrefixes: ["REDIS_URL", "REDIS_"],
    schemaPatterns: [],
  },
  {
    provider: "upstash",
    kind: "cache",
    pkgNames: ["@upstash/redis", "@upstash/ratelimit"],
    filePatterns: [],
    contentPatterns: [/from ['"]@upstash/, /Redis\.fromEnv/],
    envVarPrefixes: ["UPSTASH_REDIS_REST_URL"],
    schemaPatterns: [],
  },
  {
    provider: "s3",
    kind: "file-system",
    pkgNames: ["@aws-sdk/client-s3", "aws-sdk"],
    filePatterns: [],
    contentPatterns: [/S3Client/, /PutObjectCommand/, /new AWS\.S3/],
    envVarPrefixes: ["AWS_ACCESS_KEY_ID", "AWS_SECRET", "S3_BUCKET"],
    schemaPatterns: [],
  },
  {
    provider: "cloudinary",
    kind: "file-system",
    pkgNames: ["cloudinary", "next-cloudinary"],
    filePatterns: [],
    contentPatterns: [/cloudinary\.config/, /CloudinaryImage/],
    envVarPrefixes: ["CLOUDINARY_URL", "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME"],
    schemaPatterns: [],
  },
  {
    provider: "stripe",
    kind: "external-api",
    pkgNames: ["stripe", "@stripe/stripe-js"],
    filePatterns: [],
    contentPatterns: [/new Stripe\(/, /stripe\.checkout/, /stripe\.subscriptions/],
    envVarPrefixes: ["STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
    schemaPatterns: [],
  },
  {
    provider: "openai",
    kind: "external-api",
    pkgNames: ["openai", "@ai-sdk/openai"],
    filePatterns: [],
    contentPatterns: [/new OpenAI\(/, /openai\.chat\.completions/, /generateText.*openai/i],
    envVarPrefixes: ["OPENAI_API_KEY"],
    schemaPatterns: [],
  },
  {
    provider: "anthropic",
    kind: "external-api",
    pkgNames: ["@anthropic-ai/sdk", "@ai-sdk/anthropic"],
    filePatterns: [],
    contentPatterns: [/new Anthropic\(/, /anthropic\.messages/, /claude/i],
    envVarPrefixes: ["ANTHROPIC_API_KEY"],
    schemaPatterns: [],
  },
  {
    provider: "resend",
    kind: "external-api",
    pkgNames: ["resend"],
    filePatterns: [],
    contentPatterns: [/new Resend\(/, /resend\.emails/],
    envVarPrefixes: ["RESEND_API_KEY"],
    schemaPatterns: [],
  },
  {
    provider: "sendgrid",
    kind: "external-api",
    pkgNames: ["@sendgrid/mail"],
    filePatterns: [],
    contentPatterns: [/sgMail\.setApiKey/, /sendgrid/],
    envVarPrefixes: ["SENDGRID_API_KEY"],
    schemaPatterns: [],
  },
];

// ─── Env var scanner ──────────────────────────────────────────────────────────

function scanEnvVars(content: string): string[] {
  const vars: string[] = [];
  const matches = content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]+)/g);
  for (const m of matches) vars.push(m[1]!);
  const envMatches = content.matchAll(/env\.([A-Z_][A-Z0-9_]+)/g);
  for (const m of envMatches) vars.push(m[1]!);
  return [...new Set(vars)];
}

function parsePkgDeps(vfs: VirtualFileSystem): Record<string, string> {
  const raw = vfs["package.json"] ?? vfs["./package.json"] ?? "{}";
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...((pkg["dependencies"] as Record<string, string>) ?? {}),
      ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
    };
  } catch {
    return {};
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function analyzeDataSources(vfs: VirtualFileSystem): DiscoveredDataSource[] {
  dsSeq = 0;
  const deps = parsePkgDeps(vfs);
  const allFiles = Object.keys(vfs);
  const allContent = Object.values(vfs).join("\n");
  const globalEnvVars = scanEnvVars(allContent);
  const results: DiscoveredDataSource[] = [];

  for (const sig of PROVIDERS) {
    let confidence = 0;
    const detectedFrom: string[] = [];
    const configFiles: string[] = [];
    const schemaFiles: string[] = [];
    const usedInFiles: string[] = [];

    for (const pkg of sig.pkgNames) {
      if (pkg in deps) {
        confidence += 0.5;
        break;
      }
    }

    for (const pattern of sig.filePatterns) {
      const matched = allFiles.filter((f) => pattern.test(f));
      if (matched.length > 0) {
        confidence += 0.2;
        configFiles.push(...matched);
        detectedFrom.push(...matched);
      }
    }

    for (const [filePath, content] of Object.entries(vfs)) {
      for (const pattern of sig.contentPatterns) {
        if (pattern.test(content)) {
          confidence += 0.1;
          if (!usedInFiles.includes(filePath)) usedInFiles.push(filePath);
          if (!detectedFrom.includes(filePath)) detectedFrom.push(filePath);
          break;
        }
      }
    }

    for (const prefix of sig.envVarPrefixes) {
      if (globalEnvVars.some((v) => v.startsWith(prefix))) {
        confidence += 0.15;
      }
    }

    for (const pattern of sig.schemaPatterns) {
      const matched = allFiles.filter((f) => pattern.test(f));
      schemaFiles.push(...matched);
    }

    const envVarsReferenced = globalEnvVars.filter((v) =>
      sig.envVarPrefixes.some((prefix) => v.startsWith(prefix))
    );

    if (confidence >= 0.2) {
      results.push({
        id: nextId(),
        kind: sig.kind,
        provider: sig.provider,
        confidence: Math.min(1, parseFloat(confidence.toFixed(3))),
        detectedFrom: [...new Set(detectedFrom)],
        configFiles: [...new Set(configFiles)],
        envVarsReferenced,
        usedInRouteIds: [],
        usedInFiles: [...new Set(usedInFiles)],
        schemaFiles: [...new Set(schemaFiles)],
      });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}
