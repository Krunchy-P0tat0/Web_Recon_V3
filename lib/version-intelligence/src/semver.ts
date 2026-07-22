import type { SemVer, BumpType } from "./types.js";

export const INITIAL_VERSION = "0.1.0";

export function parse(v: string): SemVer {
  const [major = 0, minor = 0, patch = 0] = v
    .replace(/^v/, "")
    .split(".")
    .map(n => parseInt(n, 10));
  return {
    major: isNaN(major) ? 0 : major,
    minor: isNaN(minor) ? 0 : minor,
    patch: isNaN(patch) ? 0 : patch,
  };
}

export function format(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function bump(current: string, type: BumpType): string {
  const v = parse(current);
  switch (type) {
    case "major": return format({ major: v.major + 1, minor: 0, patch: 0 });
    case "minor": return format({ major: v.major, minor: v.minor + 1, patch: 0 });
    case "patch": return format({ major: v.major, minor: v.minor, patch: v.patch + 1 });
  }
}

export function isValid(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v.replace(/^v/, ""));
}

export function compare(a: string, b: string): number {
  const av = parse(a);
  const bv = parse(b);
  if (av.major !== bv.major) return av.major - bv.major;
  if (av.minor !== bv.minor) return av.minor - bv.minor;
  return av.patch - bv.patch;
}
