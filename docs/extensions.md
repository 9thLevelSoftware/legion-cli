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

Governed runs require the in-process `http` adapter because its tool host can
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

Four packs ship with the agents package:

- `extension:accessibility`: axe/Playwright plus keyboard, focus, and manual checks.
- `extension:performance`: startup, interaction, resources, and memory against local baselines.
- `extension:migration-rollback`: disposable forward/rollback/restore/idempotency rehearsal.
- `extension:release-readiness`: artifact, version/tag, consumer install, and per-platform evidence.

`skills install --extension <id>` uses the same integrity model as skill overlays:
local unsigned installs require `--unsigned`; remote GitHub tag installs require a
trusted minisign signature; every installed tree is pinned by SHA-256.
