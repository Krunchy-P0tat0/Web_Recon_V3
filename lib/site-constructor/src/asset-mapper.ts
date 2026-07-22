import type { AssetGraph, AssetEntry } from "@workspace/site-intelligence";
import type { PortablePageNode } from "@workspace/site-intelligence";

// ---------------------------------------------------------------------------
// resolveAssetUrl
// Returns the best available URL for a given asset entry.
// Priority: publicPath > cloudPath > sourceUrl
// ---------------------------------------------------------------------------

export function resolveAssetUrl(asset: AssetEntry): string {
  if (asset.cloudPath && asset.cloudPath.startsWith("http")) return asset.cloudPath;
  if (asset.localPath && asset.localPath.startsWith("http")) return asset.localPath;
  return asset.sourceUrl;
}

// ---------------------------------------------------------------------------
// buildAssetMap
// Creates a lookup map from sourceUrl → best resolved URL.
// Used to rewrite asset references in cleanHtml.
// ---------------------------------------------------------------------------

export function buildAssetMap(assetGraph: AssetGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const asset of assetGraph.assets) {
    if (asset.isDuplicate && asset.duplicateOf) {
      const canonical = assetGraph.assets.find((a) => a.id === asset.duplicateOf);
      if (canonical) {
        map.set(asset.sourceUrl, resolveAssetUrl(canonical));
        if (asset.normalizedUrl) map.set(asset.normalizedUrl, resolveAssetUrl(canonical));
        continue;
      }
    }
    const resolved = resolveAssetUrl(asset);
    map.set(asset.sourceUrl, resolved);
    if (asset.normalizedUrl) map.set(asset.normalizedUrl, resolved);
  }
  return map;
}

// ---------------------------------------------------------------------------
// remapContentAssets
// Rewrites src/href attributes in cleanHtml to use resolved asset URLs.
// Also fixes relative URLs relative to the page's original URL.
// ---------------------------------------------------------------------------

export function remapContentAssets(
  html: string,
  assetMap: Map<string, string>,
  baseUrl: string
): string {
  if (!html) return html;

  let result = html;

  // Remap img src attributes
  result = result.replace(/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (match, prefix, quote, url) => {
    const resolved = resolveUrl(url, baseUrl, assetMap);
    return `${prefix}${quote}${resolved}${quote}`;
  });

  // Remap srcset attributes
  result = result.replace(/(<img\b[^>]*?\bsrcset=)(["'])([^"']+)\2/gi, (_m, prefix, quote, srcset) => {
    const parts = srcset.split(",").map((part: string) => {
      const [url, descriptor] = part.trim().split(/\s+/);
      const resolved = resolveUrl(url, baseUrl, assetMap);
      return descriptor ? `${resolved} ${descriptor}` : resolved;
    });
    return `${prefix}${quote}${parts.join(", ")}${quote}`;
  });

  // Remap video/source src
  result = result.replace(/(<(?:source|video)\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (match, prefix, quote, url) => {
    const resolved = resolveUrl(url, baseUrl, assetMap);
    return `${prefix}${quote}${resolved}${quote}`;
  });

  return result;
}

// ---------------------------------------------------------------------------
// getHeroImageUrl
// Returns the best hero image URL for a page node.
// ---------------------------------------------------------------------------

export function getHeroImageUrl(
  node: PortablePageNode | null,
  assetMap: Map<string, string>
): string | null {
  if (!node) return null;
  const images = node.media.images;
  if (!images || images.length === 0) return null;

  // Prefer the first large image
  const sorted = [...images].sort((a, b) => {
    const aScore = (a.dimensions?.width ?? 0) * (a.dimensions?.height ?? 0);
    const bScore = (b.dimensions?.width ?? 0) * (b.dimensions?.height ?? 0);
    return bScore - aScore;
  });

  const img = sorted[0];
  if (!img) return null;

  return assetMap.get(img.sourceUrl) ?? assetMap.get(img.normalizedUrl ?? "") ?? img.sourceUrl;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveUrl(url: string, baseUrl: string, assetMap: Map<string, string>): string {
  // Already mapped
  if (assetMap.has(url)) return assetMap.get(url)!;

  // Already absolute
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")) {
    return url;
  }

  // Data URI — leave as-is
  if (url.startsWith("data:")) return url;

  // Try resolving relative URL against base
  try {
    const resolved = new URL(url, baseUrl).href;
    if (assetMap.has(resolved)) return assetMap.get(resolved)!;
    return resolved;
  } catch {
    return url;
  }
}
