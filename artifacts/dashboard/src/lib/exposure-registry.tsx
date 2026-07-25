/**
 * exposure-registry.tsx — No-op stub
 *
 * Full ExposureRegistryProvider implementation requires expanding the OpenAPI
 * spec with /audit/frontend-exposures and running codegen (Phase 4).
 * This stub keeps all pages that call useExposeFeature compiling without errors.
 */
import * as React from "react";

export interface ExposureInput {
  featureId: string;
  exposureType: string;
  location: string;
  label: string;
}

export function ExposureRegistryProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useExposeFeature(_exposure: ExposureInput) {
  // no-op until Phase 4 expands the OpenAPI spec
}
