import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventStreamProvider } from "@/contexts/EventStreamContext";
import { Shell } from "@/components/layout/Shell";
import { Toaster } from "@/components/ui/toaster";

// V1 pages — real data, tested
import Dashboard from "@/pages/Dashboard";
import Jobs from "@/pages/Jobs";
import JobMissionControl from "@/pages/JobMissionControl";
import RecoveryCenter from "@/pages/RecoveryCenter";
import DifferentialCenter from "@/pages/DifferentialCenter";
import ManifestCenter from "@/pages/ManifestCenter";

// V2 pages — ported, adapted to V1 endpoints
import Storage from "@/pages/Storage";
import Diagnostics from "@/pages/Diagnostics";
import Audit from "@/pages/Audit";

import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5000 },
  },
});

function AppRouter() {
  return (
    <Shell>
      <Switch>
        {/* V1 pipeline pages */}
        <Route path="/" component={Dashboard} />
        <Route path="/jobs/:jobId" component={JobMissionControl} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/recovery" component={RecoveryCenter} />
        <Route path="/differential" component={DifferentialCenter} />
        <Route path="/manifest" component={ManifestCenter} />

        {/* V2 utility pages */}
        <Route path="/storage" component={Storage} />
        <Route path="/dev/diagnostics" component={Diagnostics} />
        <Route path="/dev/audit" component={Audit} />

        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Single shared SSE connection for the entire app */}
      <EventStreamProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRouter />
        </WouterRouter>
        <Toaster />
      </EventStreamProvider>
    </QueryClientProvider>
  );
}
