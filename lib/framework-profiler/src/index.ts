export { buildFrameworkProfile } from "./profiler.js";
export { detectFrontend }        from "./frontend-detector.js";
export { detectBackend }         from "./backend-detector.js";
export { detectDatabase }        from "./database-detector.js";
export { scoreHostingCompatibility, detectCurrentHosting } from "./hosting-scorer.js";

export type {
  FrameworkProfile,
  FrontendProfile,
  BackendProfile,
  DatabaseProfile,
  HostingProfile,
  HostingCompatibility,
  FrontendFramework,
  BackendFramework,
  DatabaseKind,
  HostingProvider,
  DeployReadiness,
} from "./types.js";
