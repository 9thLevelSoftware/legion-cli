// Shared contract between scripts/native-host-smoke.mjs (producer) and build-wasi-host.mjs --assemble (consumer).
export const NATIVE_SMOKE_CASES = [
  { id: "pass", status: "passed" },
  { id: "wrong-value", status: "failed" },
  { id: "missing-pointer", status: "failed" },
  { id: "large-1mib-pass", status: "passed" },
  { id: "fuel-bound-2mib-unavailable", status: "unavailable" },
];

export function nativeGuardKind(target) {
  return target === "x86_64-pc-windows-msvc" ? "windows-job-committed" : "unix-address-space";
}
