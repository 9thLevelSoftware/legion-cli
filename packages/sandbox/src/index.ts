import type * as ComponentExports from "./component.js";

export { SandboxError } from "./errors.js";
export {
  ALLOWLIST_TRUST_TIER_NOTE,
  WINDOWS_ALLOWLIST_TRUST_TIER_NOTE,
  assertExecuteSandbox,
  detectSandbox,
  hardenedSandboxAvailable,
  jailSeatbeltProfile,
  materializeJail,
  retainedJailIdentity,
  reopenJail,
  prepareVerificationWrapper,
  resolveVerificationTrustTier,
  verificationBwrapArgvPrefix,
  verificationReadOnlyRels,
  verificationSeatbeltProfile,
} from "./sandbox.js";
export {
  DOCKER_HOST_EXEC_REFUSAL,
  DOCKER_PIDS_LIMIT,
  DOCKER_PINNED_IMAGE,
  DOCKER_WORKDIR,
  dockerArgvPrefix,
  findRunnableDocker,
  translateHostPathToDocker,
  translateWrapperInvoke,
} from "./docker.js";
export type {
  SandboxBackend,
  SandboxApplyResult,
  SandboxHandle,
  SandboxOutput,
  SandboxOutputChange,
  SandboxPolicy,
  VerificationInformationFlow,
  VerificationTrustFlags,
  VerificationTrustPosture,
  VerificationWrapperOptions,
  VerificationWrapper,
  VerifyTrustTier,
} from "./sandbox.js";
type ComponentModule = typeof ComponentExports;
let componentModule: Promise<ComponentModule> | undefined;
const loadComponent = (): Promise<ComponentModule> => (componentModule ??= import("./component.js"));
export const resolveComponentRuntime: ComponentModule["resolveComponentRuntime"] = async (...args) =>
  (await loadComponent()).resolveComponentRuntime(...args);
export const runComponentValidator: ComponentModule["runComponentValidator"] = async (...args) =>
  (await loadComponent()).runComponentValidator(...args);
export const snapshotComponentFiles: ComponentModule["snapshotComponentFiles"] = async (...args) =>
  (await loadComponent()).snapshotComponentFiles(...args);
export type { ComponentValidationResult } from "./component.js";
export type { ComponentInput, ComponentRawInput, ComponentRuntimeIdentity, ValidatorOutput } from "@9thlevelsoftware/legion-cli-schema";
