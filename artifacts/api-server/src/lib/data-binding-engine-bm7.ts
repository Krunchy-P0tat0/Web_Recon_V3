/**
 * data-binding-engine-bm7.ts — Phase BM-7: Data Binding Engine
 *
 * Binds generated pages to live backend data by mapping each page to the
 * backend API endpoints and database models it requires.
 *
 * Outputs (disk + R2):
 *   binding-map.json
 *
 * Schema of each binding entry:
 *   { page, endpoint, model, bindingType }
 *
 * bindingType values:
 *   static          — page has no dynamic data (landing page, about page)
 *   server-fetch    — data fetched server-side at render time (SSR/ISR)
 *   client-fetch    — data fetched client-side after hydration (CSR)
 *   real-time       — data bound via WebSocket / SSE
 *   form-submit     — page contains a form whose submission POSTs to endpoint
 *   file-upload     — page contains a file upload bound to a storage endpoint
 *   auth-gated      — page is behind auth; identity comes from auth provider
 *   paginated       — page displays a list with server-side pagination
 *   search          — page has a search/filter bound to a query endpoint
 *   mutation        — page triggers a data-mutating call (POST/PUT/DELETE)
 *
 * Success criteria:
 *   Generated pages become live pages rather than static pages.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Binding type
// ---------------------------------------------------------------------------

export type BindingType =
  | "static"
  | "server-fetch"
  | "client-fetch"
  | "real-time"
  | "form-submit"
  | "file-upload"
  | "auth-gated"
  | "paginated"
  | "search"
  | "mutation";

export type BindingStatus =
  | "BOUND"        // binding is fully resolved — endpoint + model + type known
  | "PARTIAL"      // endpoint found but model is unknown
  | "UNBOUND"      // no matching endpoint found; page will remain static
  | "BLOCKED";     // endpoint exists but binding is unsafe (auth, CORS, deprecated)

// ---------------------------------------------------------------------------
// Input descriptors
// ---------------------------------------------------------------------------

export interface PageDescriptor {
  id?:           string;
  path:          string;         // URL path, e.g. "/dashboard"
  name?:         string;         // component name, e.g. "DashboardPage"
  title?:        string;         // human-readable page title
  hasForm?:      boolean;
  hasSearch?:    boolean;
  hasPagination?: boolean;
  isAuthRequired?: boolean;
  dataHints?:    string[];       // keywords from the page: "user", "posts", "orders"
  primeTemplate?: string;        // which prime template this page was generated from
}

export interface ApiEndpointRef {
  id?:           string;
  path:          string;
  methods:       string[];
  protocol?:     string;         // rest | graphql | trpc
  auth?:         boolean;
  deprecated?:   boolean;
  returns?:      string;         // resource name, e.g. "User", "Post[]"
  tags?:         string[];
}

export interface DatabaseModelRef {
  id?:           string;
  name:          string;         // e.g. "User", "Post", "Order"
  tableName?:    string;         // DB table name
  fields?:       string[];       // key fields
  relations?:    string[];       // related model names
}

export interface DataBindingInput {
  primeJobId:    string;
  backendJobId?: string;
  force?:        boolean;
  pages?:        PageDescriptor[];
  endpoints?:    ApiEndpointRef[];
  models?:       DatabaseModelRef[];
  framework?:    string;
  renderMode?:   "ssr" | "csr" | "ssg" | "isr" | "hybrid";
}

// ---------------------------------------------------------------------------
// Binding map entry
// ---------------------------------------------------------------------------

export interface BindingEntry {
  id:            string;
  page:          PageDescriptor;
  endpoint:      ApiEndpointRef | null;   // null when static or unbound
  model:         DatabaseModelRef | null; // null when endpoint has no DB model
  bindingType:   BindingType;
  status:        BindingStatus;
  confidence:    number;           // 0–1
  renderHint:    string;           // suggested fetch strategy for the framework
  queryKey?:     string;           // React Query / SWR cache key suggestion
  loadingState?: string;           // suggested loading state name
  errorState?:   string;           // suggested error state name
  authRequired?: boolean;          // true when endpoint requires authentication
  notes:         string[];
}

// ---------------------------------------------------------------------------
// Output — binding-map.json
// ---------------------------------------------------------------------------

export interface BindingMap {
  schemaVersion:  "BM-7";
  primeJobId:     string;
  backendJobId:   string;
  generatedAt:    string;
  durationMs:     number;
  framework:      string;
  renderMode:     string;
  totalPages:     number;
  boundCount:     number;
  partialCount:   number;
  unboundCount:   number;
  blockedCount:   number;
  livePageRate:   number;          // fraction of pages that are now live (BOUND or PARTIAL)
  bindings:       BindingEntry[];
  // Grouped views
  bound:          BindingEntry[];
  partial:        BindingEntry[];
  unbound:        BindingEntry[];
  blocked:        BindingEntry[];
  // Type-grouped view
  byType:         Record<BindingType, BindingEntry[]>;
  // Endpoint usage (which endpoints are used by which pages)
  endpointUsage:  Array<{ endpointPath: string; usedByPages: string[] }>;
  // Model usage (which models are needed)
  modelUsage:     Array<{ modelName: string; usedByPages: string[] }>;
  summary: {
    totalEndpointsUsed: number;
    totalModelsUsed:    number;
    staticPages:        number;
    dynamicPages:       number;
    authGatedPages:     number;
    realtimePages:      number;
    unboundWarnings:    string[];
    recommendation:     string;
  };
  r2Key?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, BindingMap>();

export function getCachedBindingMap(primeJobId: string): BindingMap | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

let _seq = 0;
function nextId(): string { return `BND-${String(++_seq).padStart(4, "0")}`; }

// ---------------------------------------------------------------------------
// Keyword → model/endpoint matching
// ---------------------------------------------------------------------------

const RESOURCE_KEYWORDS: Record<string, string[]> = {
  user:    ["user", "users", "account", "accounts", "profile", "me", "auth"],
  post:    ["post", "posts", "article", "articles", "blog", "entry"],
  comment: ["comment", "comments", "reply", "replies", "feedback"],
  product: ["product", "products", "item", "items", "catalog", "sku"],
  order:   ["order", "orders", "purchase", "purchases", "cart", "checkout"],
  payment: ["payment", "payments", "invoice", "invoices", "billing"],
  file:    ["file", "files", "upload", "uploads", "attachment", "media"],
  message: ["message", "messages", "chat", "notification", "notifications"],
  tag:     ["tag", "tags", "category", "categories", "label"],
  search:  ["search", "query", "filter", "find"],
};

function keywordsForPage(page: PageDescriptor): Set<string> {
  const words = new Set<string>();
  const sources = [
    page.path,
    page.name ?? "",
    page.title ?? "",
    ...(page.dataHints ?? []),
    page.primeTemplate ?? "",
  ];

  for (const src of sources) {
    for (const word of src.toLowerCase().split(/[\W_]+/)) {
      if (word) words.add(word);
    }
  }
  return words;
}

function scoreEndpoint(ep: ApiEndpointRef, pageKeywords: Set<string>): number {
  let score = 0;
  const epWords = new Set(
    [ep.path, ...(ep.tags ?? []), ep.returns ?? ""]
      .join(" ").toLowerCase().split(/[\W_]+/)
      .filter(Boolean)
  );

  for (const kw of pageKeywords) {
    if (epWords.has(kw)) score += 10;
    // Check resource keyword groups
    for (const [resource, aliases] of Object.entries(RESOURCE_KEYWORDS)) {
      if (aliases.includes(kw) && aliases.some(a => epWords.has(a))) score += 5;
    }
  }

  return score;
}

function scoreModel(model: DatabaseModelRef, pageKeywords: Set<string>): number {
  let score = 0;
  const modelWords = new Set(
    [model.name, model.tableName ?? "", ...(model.fields ?? []), ...(model.relations ?? [])]
      .join(" ").toLowerCase().split(/[\W_]+/)
      .filter(Boolean)
  );

  for (const kw of pageKeywords) {
    if (modelWords.has(kw)) score += 10;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Binding type inference
// ---------------------------------------------------------------------------

function inferBindingType(
  page: PageDescriptor,
  ep: ApiEndpointRef | null,
  renderMode: string,
): BindingType {
  if (!ep) return "static";

  if (page.isAuthRequired) return "auth-gated";
  if (page.hasForm && ep.methods.some(m => ["POST", "PUT", "PATCH"].includes(m))) return "form-submit";
  if (page.hasSearch)      return "search";
  if (page.hasPagination)  return "paginated";

  const hasMutation = ep.methods.some(m => ["POST", "PUT", "PATCH", "DELETE"].includes(m));
  if (hasMutation && !page.hasForm) return "mutation";

  if (ep.tags?.includes("realtime") || ep.tags?.includes("ws") || ep.tags?.includes("sse")) {
    return "real-time";
  }
  if (ep.tags?.includes("upload")) return "file-upload";

  const isRead = ep.methods.includes("GET") || ep.methods.includes("HEAD");
  if (!isRead) return "mutation";

  if (renderMode === "ssr" || renderMode === "isr") return "server-fetch";
  return "client-fetch";
}

// ---------------------------------------------------------------------------
// Render hint
// ---------------------------------------------------------------------------

function buildRenderHint(type: BindingType, framework: string, ep: ApiEndpointRef | null): string {
  if (type === "static") return "No data fetching required — render as a static page";

  const path = ep?.path ?? "<endpoint>";

  switch (type) {
    case "server-fetch":
      if (framework === "nextjs") return `Use async Server Component: const data = await fetch("${path}")`;
      if (framework === "nuxt")   return `Use useFetch("${path}") in <script setup>`;
      return `Fetch ${path} server-side and pass as props`;
    case "client-fetch":
      return `useQuery({ queryKey: ["${path}"], queryFn: () => fetch("${path}").then(r => r.json()) })`;
    case "real-time":
      return `Use useWebSocket("${path}") or EventSource("${path}") for real-time updates`;
    case "form-submit":
      return `On submit: fetch("${path}", { method: "POST", body: JSON.stringify(formData) })`;
    case "file-upload":
      return `Use FormData + fetch("${path}", { method: "POST", body: formData })`;
    case "auth-gated":
      return `Wrap page with auth guard; fetch user from auth provider, then load ${path}`;
    case "paginated":
      return `useInfiniteQuery or cursor param: fetch("${path}?page={n}&limit=20")`;
    case "search":
      return `Debounce input → fetch("${path}?q={query}") on change`;
    case "mutation":
      return `useMutation: fetch("${path}", { method: "POST/PUT/DELETE", body })`;
    default:
      return `Fetch data from ${path}`;
  }
}

// ---------------------------------------------------------------------------
// Build a single binding entry
// ---------------------------------------------------------------------------

function buildBinding(
  page: PageDescriptor,
  endpoints: ApiEndpointRef[],
  models: DatabaseModelRef[],
  renderMode: string,
  framework: string,
): BindingEntry {
  const id       = page.id ?? nextId();
  const keywords = keywordsForPage(page);

  // Score and select best endpoint
  const scored = endpoints
    .map(ep => ({ ep, score: scoreEndpoint(ep, keywords) }))
    .sort((a, b) => b.score - a.score);

  const bestEp    = scored.length && scored[0]!.score > 0 ? scored[0]!.ep : null;
  const bindType  = inferBindingType(page, bestEp, renderMode);

  // Score and select best model
  const scoredModels = models
    .map(m => ({ m, score: scoreModel(m, keywords) }))
    .sort((a, b) => b.score - a.score);
  const bestModel = scoredModels.length && scoredModels[0]!.score > 0 ? scoredModels[0]!.m : null;

  // Status
  let status: BindingStatus = "UNBOUND";
  let confidence = 0.3;

  if (bestEp) {
    if (bestEp.deprecated) {
      status = "BLOCKED";
      confidence = 0.9;
    } else if (bestModel) {
      status = "BOUND";
      confidence = 0.85;
    } else {
      status = "PARTIAL";
      confidence = 0.65;
    }
  } else if (bindType === "static") {
    status = "BOUND";
    confidence = 1.0;
  }

  const renderHint = buildRenderHint(bindType, framework, bestEp);
  const queryKey   = bestEp ? `["${bestEp.path.replace(/\//g, "-").replace(/^-/, "")}"]` : undefined;
  const notes: string[] = [];

  if (status === "UNBOUND") {
    notes.push(`No matching API endpoint found for "${page.path}" — this page will serve static content only`);
    notes.push(`Add data hints (dataHints field) or create a backend endpoint to unlock live data binding`);
  }
  if (status === "BLOCKED") {
    notes.push(`Matched endpoint ${bestEp?.path} is deprecated — find a non-deprecated replacement`);
  }
  if (status === "PARTIAL") {
    notes.push(`Endpoint ${bestEp?.path} found but no database model matched — binding is functional but incomplete`);
  }
  if (bestEp?.auth && !page.isAuthRequired) {
    notes.push(`Endpoint ${bestEp.path} requires auth; mark this page isAuthRequired: true`);
  }

  return {
    id,
    page,
    endpoint:     bestEp,
    model:        bestModel,
    bindingType:  bindType,
    status,
    confidence,
    renderHint,
    queryKey,
    loadingState: bestEp ? `is${page.name ?? "Page"}Loading` : undefined,
    errorState:   bestEp ? `${page.name?.toLowerCase() ?? "page"}Error` : undefined,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function buildEndpointUsage(bindings: BindingEntry[]): BindingMap["endpointUsage"] {
  const map = new Map<string, string[]>();
  for (const b of bindings) {
    if (!b.endpoint) continue;
    const key = b.endpoint.path;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(b.page.path);
  }
  return [...map.entries()].map(([endpointPath, usedByPages]) => ({ endpointPath, usedByPages }));
}

function buildModelUsage(bindings: BindingEntry[]): BindingMap["modelUsage"] {
  const map = new Map<string, string[]>();
  for (const b of bindings) {
    if (!b.model) continue;
    const key = b.model.name;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(b.page.path);
  }
  return [...map.entries()].map(([modelName, usedByPages]) => ({ modelName, usedByPages }));
}

const ALL_BINDING_TYPES: BindingType[] = [
  "static", "server-fetch", "client-fetch", "real-time",
  "form-submit", "file-upload", "auth-gated", "paginated", "search", "mutation",
];

function groupByType(bindings: BindingEntry[]): Record<BindingType, BindingEntry[]> {
  return Object.fromEntries(
    ALL_BINDING_TYPES.map(t => [t, bindings.filter(b => b.bindingType === t)])
  ) as Record<BindingType, BindingEntry[]>;
}

// ---------------------------------------------------------------------------
// Disk / R2 helpers
// ---------------------------------------------------------------------------

async function saveToDisk(jobId: string, map: BindingMap): Promise<void> {
  const dir = join("/tmp/bm7", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "binding-map.json"), JSON.stringify(map, null, 2));
}

async function saveToR2(jobId: string, map: BindingMap): Promise<string | undefined> {
  try {
    const cloud = getDefaultCloudProvider();
    const key   = `bm7/${jobId}/binding-map.json`;
    await cloud.upload({ key, data: Buffer.from(JSON.stringify(map, null, 2)), contentType: "application/json" });
    return key;
  } catch (err) {
    logger.warn({ err, jobId }, "BM7: R2 upload failed (non-fatal)");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runDataBindingEngine(
  input: DataBindingInput,
): Promise<BindingMap> {
  const { primeJobId, backendJobId = "unknown", force = false } = input;
  const t0 = Date.now();

  if (!force) {
    const cached = _cache.get(primeJobId);
    if (cached) {
      logger.info({ primeJobId }, "BM7: returning cached binding map");
      return cached;
    }
  }

  logger.info({ primeJobId, backendJobId }, "BM7: data binding engine started");

  const pages      = (input.pages      ?? []).map((p, i) => ({ ...p, id: p.id ?? `PG-${String(i + 1).padStart(4, "0")}` }));
  const endpoints  = (input.endpoints  ?? []).map((e, i) => ({ ...e, id: e.id ?? `EP-${String(i + 1).padStart(4, "0")}` }));
  const models     = (input.models     ?? []).map((m, i) => ({ ...m, id: m.id ?? `MDL-${String(i + 1).padStart(4, "0")}` }));
  const framework  = input.framework  ?? "react";
  const renderMode = input.renderMode ?? "csr";

  // Build bindings
  const bindings = pages.map(page => buildBinding(page, endpoints, models, renderMode, framework));

  // Views
  const bound   = bindings.filter(b => b.status === "BOUND");
  const partial = bindings.filter(b => b.status === "PARTIAL");
  const unbound = bindings.filter(b => b.status === "UNBOUND");
  const blocked = bindings.filter(b => b.status === "BLOCKED");

  const livePageRate = pages.length
    ? (bound.length + partial.length) / pages.length
    : 1;

  const dynamicPages  = bindings.filter(b => b.bindingType !== "static").length;
  const staticPages   = bindings.filter(b => b.bindingType === "static").length;
  const authGated     = bindings.filter(b => b.bindingType === "auth-gated").length;
  const realtimePages = bindings.filter(b => b.bindingType === "real-time").length;

  const endpointUsage = buildEndpointUsage(bindings);
  const modelUsage    = buildModelUsage(bindings);
  const byType        = groupByType(bindings);

  const unboundWarnings = unbound.map(b =>
    `Page "${b.page.path}" has no data binding — add an API endpoint or mark it static`
  );

  const recommendation =
    livePageRate >= 0.9 ? "Excellent binding coverage — almost all pages are live. Audit PARTIAL bindings to complete model mapping." :
    livePageRate >= 0.7 ? "Good coverage — review UNBOUND pages and add backend endpoints where needed." :
    livePageRate >= 0.5 ? "Moderate coverage — significant pages remain static. Prioritise UNBOUND page → endpoint matching." :
                          "Low binding coverage — most pages are still static. Add API endpoints and database models to unlock live data.";

  const totalEndpointsUsed = new Set(bindings.map(b => b.endpoint?.path).filter(Boolean)).size;
  const totalModelsUsed    = new Set(bindings.map(b => b.model?.name).filter(Boolean)).size;

  const map: BindingMap = {
    schemaVersion:  "BM-7",
    primeJobId,
    backendJobId,
    generatedAt:    new Date().toISOString(),
    durationMs:     Date.now() - t0,
    framework,
    renderMode,
    totalPages:     bindings.length,
    boundCount:     bound.length,
    partialCount:   partial.length,
    unboundCount:   unbound.length,
    blockedCount:   blocked.length,
    livePageRate,
    bindings,
    bound,
    partial,
    unbound,
    blocked,
    byType,
    endpointUsage,
    modelUsage,
    summary: {
      totalEndpointsUsed,
      totalModelsUsed,
      staticPages,
      dynamicPages,
      authGatedPages:  authGated,
      realtimePages,
      unboundWarnings,
      recommendation,
    },
  };

  try {
    await saveToDisk(primeJobId, map);
    const r2Key = await saveToR2(primeJobId, map);
    if (r2Key) map.r2Key = r2Key;
  } catch (err) {
    logger.warn({ err, primeJobId }, "BM7: persistence failed (non-fatal)");
  }

  _cache.set(primeJobId, map);
  logger.info(
    { primeJobId, livePageRate: Math.round(livePageRate * 100) + "%", bound: bound.length, unbound: unbound.length },
    "BM7: data binding engine complete",
  );

  return map;
}
