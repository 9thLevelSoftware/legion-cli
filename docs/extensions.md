# Governed extensions

Legion CLI extensions are separate from the closed lifecycle `SkillId` set. They
use references such as `extension:accessibility` and run as evidence jobs; they do
not execute product changes directly.

```text
legion-cli skills list
legion-cli skills show extension:accessibility
legion-cli skills run extension:accessibility --profile local-http
```

An extension manifest uses standard Agent Skills frontmatter plus
`metadata.legion.extensionId`, version, required checks, resources, required tools,
and read/write/command permissions. Extension writes are restricted to
`.legion-cli/extensions/runs/<runId>/`. Product recommendations go into
`recommendations.json`; Legion files them as normal tickets so later execution is
covered by a task FileContract.

`compatibility` is required and currently informational for operators. Every
declared resource must resolve to a regular, non-symlink file inside the
extension tree; catalog loading, installation, and execution all fail closed
when a resource is missing or unsafe.

Absent component runtime metadata, governed model runs require the in-process `http` adapter because its tool host can
enforce exact argv-prefix grants (for example, `npx axe` cannot run
`npx unrelated`). Manifest `Bash(...)` entries must exactly match command
permissions. Read permissions use explicit file or directory roots; glob grants
are rejected rather than widened. Spawn CLI adapters are refused for
extension jobs. The `fake` adapter is accepted only as the deterministic test
fixture.

Extension commands are network denied by default. Bubblewrap commands add a
separate network namespace and Docker commands use `--network none`; shared
seatbelt/copy wrappers do not expose command execution. Packs therefore use
locally installed, pinned tools and record missing command capability as
unavailable rather than allowing `npx` to fetch registry code.

## Capability-limited component extensions

`extension:json-contract` runs the packaged native Wasmtime helper, not a model.
Its manifest declares `runtime.kind: wasi-component`, ABI `legion-validator/v1`,
an `assets/` component path and the actual component SHA-256. All declared
resources must still live under `scripts/`, `references/` or `assets/`; the SDK is
[`extensions/json-contract/references/SDK.md`](../extensions/json-contract/references/SDK.md).

For `data/business.json` containing `{"answer":42}`, an invocation file is:

```json
{
  "schemaVersion": "legion-cli-component-invocation/v1",
  "checks": [{
    "id": "json-contract",
    "configuration": {
      "assertions": [{
        "id": "business-answer",
        "predicate": {"file":"data/business.json","pointer":"/answer","op":"eq","expected":42}
      }]
    },
    "files": ["data/business.json"]
  }]
}
```

```text
pnpm exec legion-cli skills run extension:json-contract --validator-input invocation.json
```

The document must select every required extension check exactly once and name
concrete files within the extension's declared read roots. Source bytes are read
by the host, never embedded in the invocation. Components require
`--validator-input` and reject `--profile`; legacy model extensions reject
`--validator-input`. Protected controls, aliases and out-of-permission paths fail
before execution. Failed JSON assertions produce ordinary `bug`/`P2` suggestions.
Ticket conversion retains the existing active-spec prerequisite and never
executes a recommendation or repairs the product automatically.

The import-free guest receives only its immutable packet: no filesystem,
network, environment, process, clock or random imports. Fixed bounds include
16 MiB component bytes, 8 MiB input, 1 MiB decoded result, 20 million fuel,
1 MiB Wasm stack, 32 instances, four 64 MiB memories, sixteen 100,000-element
tables and a 20-second parent deadline including compilation. Result lifting
checks storage and decoded size before owned allocation and before automatic
post-return; its doc-hidden lifting API is pinned to Wasmtime 49.0.2 and must be
reviewed on upgrade.

Before parsing or compilation, the helper establishes and probes a Windows Job
2 GiB committed-process ceiling or a Unix hard address-space ceiling of startup
virtual size plus 2 GiB—not an RSS limit. Missing/non-enforcing runtime boundaries
report unavailable; there is no PATH/download fallback. The host executes one
private verified binary snapshot for probe and validation, preventing normal
installer replacement from misbinding its identity. This does not protect
against hostile same-user modification of the engine or its private temporary
directory. Component isolation does not assert information-flow enforcement for
an ordinary vendor adapter, or the honesty of a custom validator.

The component ABI and protocol schemas are versioned separately from extension
packaging; see [Assurance integration](design/assurance-integration.md) for the
limits and trust model. The component runtime constrains guest capabilities and
resources, but does not prove validator correctness or make the surrounding
workflow information-flow safe. Linux-Docker and macOS acceptance is not
available from the current Windows-host evidence. Public GitHub signing and
attestation are separate operator-authorized workflows, not an extension action.

Normal TypeScript builds do not require Rust. Explicit local development uses
`node scripts/build-wasi-host.mjs`; local-target manifests are not complete
release coverage. Publication requires the complete native-target manifest and
separate target smoke evidence.

Musl targets use the native workspace's self-contained Rust CRT and the `cc`
linker with explicit static linking; do not substitute `musl-gcc`'s external
startup objects. A static PIE may have an ELF dynamic relocation section, but
must have neither `PT_INTERP` nor `DT_NEEDED` dependencies. The x86-64 host has
been exercised with its real component on Node 22 / Debian bookworm without a
musl loader. That local proof does not certify the ARM or macOS release targets.

Every run must produce `evidence.json`:

```json
{
  "schemaVersion": "legion-cli-extension-evidence/v1",
  "extension": "extension:accessibility",
  "checks": [
    { "id": "axe", "status": "unavailable", "detail": "browser is not installed" }
  ]
}
```

Each manifest-required check must be present exactly once. Status is `passed`,
`failed`, or `unavailable`. Missing evidence, an empty check list, duplicate IDs,
or an omitted required check fails closed. Missing required executables are added
as explicit unavailable tool checks.


Packaged extensions include:

- `extension:accessibility`: axe/Playwright plus keyboard, focus, and manual checks.
- `extension:performance`: startup, interaction, resources, and memory against local baselines.
- `extension:migration-rollback`: disposable forward/rollback/restore/idempotency rehearsal.
- `extension:release-readiness`: artifact, version/tag, consumer install, and per-platform evidence.
- `extension:json-contract`: import-free predicates over declared JSON files, with bounded evidence and normal recommendation tickets.

`skills install --extension <id>` uses the same integrity model as skill overlays:
local unsigned installs require `--unsigned`; remote GitHub tag installs require a
trusted minisign signature; every installed tree is pinned by SHA-256.
