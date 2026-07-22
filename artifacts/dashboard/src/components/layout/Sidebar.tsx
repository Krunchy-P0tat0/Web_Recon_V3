import * as React from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  Database,
  ShieldAlert,
  LayoutDashboard,
  Briefcase,
  RefreshCw,
  GitCompare,
  FileText,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const [location] = useLocation();

  const isActive = (path: string) => location === path;

  return (
    <div className="flex h-screen w-64 flex-col border-r border-border bg-sidebar text-sidebar-foreground shrink-0">
      {/* Logo / Header */}
      <div className="flex h-14 items-center border-b border-border px-6">
        <div className="flex items-center gap-2 font-mono font-bold tracking-tight text-primary">
          <Zap className="h-5 w-5 text-warning" />
          <span>CONTROL_CENTER</span>
        </div>
      </div>

      <div className="flex-1 overflow-auto py-4">
        <nav className="space-y-1 px-3">

          {/* ── Pipeline ────────────────────────────────── */}
          <div className="pb-2">
            <h4 className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
              Pipeline
            </h4>
          </div>

          <Link
            href="/"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <LayoutDashboard className="h-4 w-4" />
            Overview
          </Link>

          <Link
            href="/jobs"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/jobs")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <Briefcase className="h-4 w-4" />
            Job Control
          </Link>

          <Link
            href="/recovery"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/recovery")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <RefreshCw className="h-4 w-4" />
            Recovery &amp; Checkpoints
          </Link>

          <Link
            href="/differential"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/differential")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <GitCompare className="h-4 w-4" />
            Differential
          </Link>

          <Link
            href="/manifest"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/manifest")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <FileText className="h-4 w-4" />
            Manifest
          </Link>

          {/* ── Storage ─────────────────────────────────── */}
          <div className="pt-4 pb-2">
            <h4 className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
              Storage
            </h4>
          </div>

          <Link
            href="/storage"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/storage")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <Database className="h-4 w-4" />
            Storage
          </Link>

          {/* ── Developer Tools ──────────────────────────── */}
          <div className="pt-4 pb-2">
            <h4 className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
              Developer Tools
            </h4>
          </div>

          <Link
            href="/dev/diagnostics"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/dev/diagnostics")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <Activity className="h-4 w-4" />
            Diagnostics
          </Link>

          <Link
            href="/dev/audit"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive("/dev/audit")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <ShieldAlert className="h-4 w-4" />
            Platform Audit
          </Link>

        </nav>
      </div>

      <div className="border-t border-border p-4">
        <div className="text-xs text-muted-foreground font-mono">WEB_RECON v2.0.0-recovery</div>
      </div>
    </div>
  );
}
