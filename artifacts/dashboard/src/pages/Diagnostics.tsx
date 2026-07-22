/**
 * Diagnostics.tsx — Core health check page.
 * Ported from V2. Uses useHealthCheck hook (exists on V1's generated client).
 */
import {
  useHealthCheck,
  getHealthCheckQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, RefreshCw, Server, Wifi, Clock } from "lucide-react";

export default function Diagnostics() {
  const { data: health, isLoading, refetch, isFetching } = useHealthCheck({
    query: { refetchInterval: 10000, queryKey: getHealthCheckQueryKey() },
  });

  const isOk = health?.status === "ok";

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2 font-mono text-primary flex items-center gap-2">
            <Activity className="h-6 w-6" /> SYSTEM_DIAGNOSTICS
          </h1>
          <p className="text-muted-foreground text-sm">Direct telemetry from core backend services.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="font-mono"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          POLL_NOW
        </Button>
      </div>

      {/* Health Check Card */}
      <Card className={`border-t-4 ${isOk ? "border-t-primary" : "border-t-destructive"}`}>
        <CardHeader className="pb-4 border-b border-border bg-card/50">
          <CardTitle className="text-sm font-mono text-muted-foreground flex justify-between items-center">
            CORE_HEALTH_CHECK
            <Badge variant="outline" className="font-mono text-xs">
              GET /api/healthz
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row gap-8 items-center justify-center py-8">
            <div className="flex flex-col items-center justify-center p-8 rounded-full border-4 border-border bg-background h-48 w-48 relative">
              {isLoading ? (
                <RefreshCw className="h-12 w-12 text-muted-foreground animate-spin" />
              ) : isOk ? (
                <>
                  <div className="absolute inset-0 rounded-full border-4 border-primary/20 animate-ping" />
                  <Server className="h-12 w-12 text-primary mb-2" />
                  <span className="font-mono font-bold text-xl text-primary">ONLINE</span>
                </>
              ) : (
                <>
                  <Server className="h-12 w-12 text-destructive mb-2 opacity-50" />
                  <span className="font-mono font-bold text-xl text-destructive">ERROR</span>
                </>
              )}
            </div>

            <div className="flex-1 w-full space-y-4">
              <div className="bg-background rounded-md border border-border p-4 font-mono text-sm space-y-3">
                <div className="flex justify-between pb-2 border-b border-border/50">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Wifi className="h-3 w-3" /> STATUS_PAYLOAD
                  </span>
                  <span className={isOk ? "text-primary" : "text-destructive"}>
                    {isLoading ? "…" : JSON.stringify(health)}
                  </span>
                </div>
                <div className="flex justify-between pb-2 border-b border-border/50">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Clock className="h-3 w-3" /> LAST_POLL
                  </span>
                  <span>{new Date().toLocaleTimeString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">POLL_INTERVAL</span>
                  <span className="text-primary">10s</span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Endpoint Catalogue */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-mono text-muted-foreground">ENDPOINT_CATALOGUE</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground font-mono mb-3">
            {/* Route count from Phase 2 verification */}
            79 route files · 624 unique endpoints · 0 path collisions
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            {[
              ["GET /api/healthz", "Health check"],
              ["GET /api/jobs", "All job sets"],
              ["GET /api/orchestrate", "Pipeline jobs"],
              ["GET /api/platform/features", "Feature registry"],
              ["GET /api/events/platform", "SSE — all events"],
              ["POST /api/production-certification/run", "E5 audit"],
              ["GET /api/recovery/report", "Recovery report"],
              ["GET /api/differential/status", "Diff engine"],
            ].map(([endpoint, desc]) => (
              <div key={endpoint} className="bg-background border border-border rounded-md p-2">
                <div className="text-primary truncate">{endpoint}</div>
                <div className="text-muted-foreground mt-0.5">{desc}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
