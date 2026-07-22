/**
 * Audit.tsx — Platform Feature Audit page.
 * Uses the generated useListPlatformFeatures hook (Phase 4 codegen).
 * Wired to V1's GET /api/platform/features endpoint.
 */
import { useListPlatformFeatures } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, RefreshCw, Server, Layers, Cpu, GitBranch, Radio } from "lucide-react";

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  route: <Server className="h-3.5 w-3.5" />,
  service: <Cpu className="h-3.5 w-3.5" />,
  pipeline: <GitBranch className="h-3.5 w-3.5" />,
  worker: <Layers className="h-3.5 w-3.5" />,
  "ws-event": <Radio className="h-3.5 w-3.5" />,
};

const STATUS_COLORS: Record<string, string> = {
  active: "text-primary border-primary/40 bg-primary/10",
  stable: "text-primary border-primary/40 bg-primary/10",
  beta: "text-warning border-warning/40 bg-warning/10",
  deprecated: "text-muted-foreground border-border",
  experimental: "text-chart-3 border-chart-3/40 bg-chart-3/10",
};

export default function Audit() {
  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useListPlatformFeatures({
    query: { refetchInterval: 30000 },
  });

  const totalFeatures = data?.meta?.total ?? data?.features?.length ?? 0;
  const byCategory = data?.byCategory ?? {};

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2 font-mono text-warning flex items-center gap-2">
            <ShieldAlert className="h-6 w-6" /> PLATFORM_AUDIT
          </h1>
          <p className="text-muted-foreground text-sm">
            Complete feature registry — all engines, routes, workers, and services.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="font-mono border-warning/50 text-warning hover:bg-warning/10"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          REFRESH
        </Button>
      </div>

      {/* Hero Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-3xl font-bold font-mono text-primary">
              {isLoading ? "…" : totalFeatures}
            </div>
            <div className="text-xs text-muted-foreground font-mono mt-1">TOTAL_FEATURES</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-3xl font-bold font-mono text-chart-2">624</div>
            <div className="text-xs text-muted-foreground font-mono mt-1">HTTP_ENDPOINTS</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-3xl font-bold font-mono text-chart-3">79</div>
            <div className="text-xs text-muted-foreground font-mono mt-1">ROUTE_FILES</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-3xl font-bold font-mono text-primary">142</div>
            <div className="text-xs text-muted-foreground font-mono mt-1">LIB_ENGINES</div>
          </CardContent>
        </Card>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 pb-3 text-sm font-mono text-destructive">
            Failed to load platform features. Ensure the API server is running.
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && !data && (
        <div className="flex items-center justify-center h-32 text-primary">
          <RefreshCw className="h-6 w-6 animate-spin mr-2" />
          <span className="font-mono text-sm">Loading feature registry…</span>
        </div>
      )}

      {/* Feature categories */}
      {Object.entries(byCategory).map(([category, features]) => (
        <Card key={category} className="bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono text-muted-foreground flex items-center justify-between">
              <div className="flex items-center gap-2">
                {CATEGORY_ICONS[category] ?? <Server className="h-3.5 w-3.5" />}
                <span className="uppercase tracking-widest">{category}</span>
              </div>
              <Badge variant="outline" className="font-mono text-[10px]">
                {features.length} features
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {features.map((f) => (
                <div
                  key={f.id}
                  className="flex items-start justify-between py-2 px-3 rounded-md hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-foreground font-medium truncate">
                      {f.featureName}
                    </div>
                    {f.description && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                        {f.description}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 ml-3 shrink-0">
                    {f.supportsLiveUpdates && (
                      <Badge
                        variant="outline"
                        className="font-mono text-[9px] px-1 py-0 h-4 border-primary/40 text-primary"
                      >
                        LIVE
                      </Badge>
                    )}
                    {f.status && (
                      <Badge
                        variant="outline"
                        className={`font-mono text-[9px] px-1 py-0 h-4 ${STATUS_COLORS[f.status] ?? "text-muted-foreground border-border"}`}
                      >
                        {f.status.toUpperCase()}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Empty state */}
      {!isLoading && !error && totalFeatures === 0 && (
        <Card className="bg-card/50">
          <CardContent className="pt-6 pb-6 text-center text-muted-foreground font-mono text-sm">
            No features registered. Ensure the API server is running and the platform registry is initialized.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
