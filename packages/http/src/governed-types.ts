import type {
  AssuranceJsonValue,
  GovernedProgram,
  GovernedValueRecord,
  HttpGovernedCheckpoint,
  ProviderUsageReceipt,
  ProvenanceLabel,
} from "@9thlevelsoftware/legion-cli-schema";

export type Sha = string;
export type Id = string;
export type Json = AssuranceJsonValue;
export type { GovernedProgram, GovernedValueRecord, HttpGovernedCheckpoint, ProviderUsageReceipt };
export type AuthorityBinding = { programKind: "bootstrap" | "governed"; authorityDigest: Sha; programFingerprint: Sha };
export type ValueEvidence = { id: Id; digest: Sha; bytes: number; label: ProvenanceLabel };
export type GovernedIdentities = {
  promptFingerprint: Sha;
  configurationFingerprint: Sha;
  contractFingerprint: Sha;
  sourceFingerprint: Sha;
  jailFingerprint: Sha;
  hostFingerprint: Sha;
  approvalId: string;
  policyFingerprint: Sha;
  provider: { endpoint: string; model: string; profile: string };
};
export interface ApprovedHttpAssuranceContext {
  runId: string;
  taskId: string;
  identities: GovernedIdentities;
  manifestDigest: Sha;
  plannerInput: { approvedMetadata: Json; label: ProvenanceLabel; taskContract: Json };
  policy: Json;
}
export type ProviderPurpose =
  | { kind: "plan" }
  | { kind: "derive"; operationId: Id }
  | { kind: "rederive"; operationId: Id; originalCallId: Id }
  | { kind: "external-call"; operationId: Id; grantId: Id };
export type EffectIdentity = { actionId: Id; authority: AuthorityBinding; sinkId: Id; requestDigest: Sha; valueDigest: Sha; inputs: readonly ValueEvidence[] };
export type EffectIntent = EffectIdentity & (
  | { kind: "provider"; role: "planner" | "quarantined"; purpose: ProviderPurpose; endpoint: string; model: string; bodyDigest: Sha; requestBytes: number; requestBody: Uint8Array; inputValues: readonly { evidence: ValueEvidence; content: Uint8Array }[]; externalGrant?: { operationId: Id; grantId: Id; sinkId: Id; authority: Json; dataPointers: readonly string[] }; usage: ProviderUsageReceipt; label: ProvenanceLabel }
  | { kind: "write"; operationId: Id; path: string; value: ValueEvidence; expectedTargetDigest: Sha | null }
  | { kind: "http-mcp"; operationId: Id; grantId: Id; transportFingerprint: Sha; schemaFingerprint: Sha; fixedAuthority: Json; data: readonly { pointer: string; value: ValueEvidence; content: Uint8Array }[] }
);
export type FailureCode = "approval-required" | "policy-denied" | "stale-authority" | "target-conflict" | "budget-exceeded" | "resource-limit" | "invalid-program" | "invalid-output" | "transport-failure" | "uncertain-effect" | "missing-sealed-value" | "recovery-value-mismatch";
export type BlockCode = FailureCode;
export type EffectCompletion = {
  outcome: { kind: "success"; resultDigest: Sha } | { kind: "failure"; code: FailureCode };
  providerUsage: ProviderUsageReceipt | null;
  producedValue: GovernedValueRecord | null;
  producedBytes: Uint8Array | null;
  candidateProgram: GovernedProgram | null;
  responseDigest: Sha | null;
  responseBytes: number | null;
};
export type GovernedState = { revision: number; checkpoint: HttpGovernedCheckpoint };
export type GovernedPermit = { actionId: Id; pendingRevision: number; requestDigest: Sha };
export interface GovernedEffectHost {
  open(context: ApprovedHttpAssuranceContext, resume: boolean): Promise<GovernedState>;
  saveProgress(expectedRevision: number, next: HttpGovernedCheckpoint): Promise<GovernedState>;
  prepareEffect(expectedRevision: number, intent: EffectIntent): Promise<{ kind: "ready"; permit: GovernedPermit; state: GovernedState } | { kind: "blocked"; code: BlockCode; state: GovernedState }>;
  completeEffect(permit: GovernedPermit, completion: EffectCompletion): Promise<GovernedState>;
  markUncertain(permit: GovernedPermit, code: FailureCode): Promise<GovernedState>;
  freezeProgram(expectedRevision: number): Promise<GovernedState>;
  readSource(path: string, signal?: AbortSignal): Promise<{ content: Uint8Array; evidence: ValueEvidence }>;
  dispatchWrite(permit: GovernedPermit, contents: Uint8Array, signal?: AbortSignal): Promise<EffectCompletion>;
  /** Digest of the exact final MCP tool arguments (approved fixed authority plus data at declared pointers); refuses with policy-denied when they cannot be assembled. */
  mcpArgumentsDigest(grantId: Id, data: readonly { pointer: string; content: Uint8Array }[]): Promise<Sha>;
  dispatchMcp(permit: GovernedPermit, data: readonly { pointer: string; content: Uint8Array }[], signal?: AbortSignal): Promise<EffectCompletion>;
}

export type GovernedHttpJobFields = {
  assuranceContext: ApprovedHttpAssuranceContext;
  effectHost: GovernedEffectHost;
  promptPath?: never;
  pointerPrompt?: never;
  httpHost?: never;
};
