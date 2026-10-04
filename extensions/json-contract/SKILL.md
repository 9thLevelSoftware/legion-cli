---
{
  "name": "json-contract",
  "description": "Validate explicit JSON business predicates against declared immutable product files with an import-free component.",
  "compatibility": "Legion CLI >=0.0.0",
  "allowed-tools": "Read",
  "metadata": {
    "legion": {
      "extensionId": "json-contract",
      "version": "1.0.0",
      "requiredTools": [],
      "checks": [
        "json-contract"
      ],
      "resources": {
        "references": [
          "references/SDK.md"
        ],
        "assets": [
          "assets/json-contract.wasm"
        ]
      },
      "permissions": {
        "read": [
          "src",
          "data",
          "config",
          "test",
          "fixtures",
          "package.json"
        ],
        "write": [],
        "commands": []
      },
      "runtime": {
        "kind": "wasi-component",
        "abi": "legion-validator/v1",
        "component": "assets/json-contract.wasm",
        "sha256": "05da5e9ad6650f60ea4b7ff54a1e2ed96d559bf93f6ed62074c5b7065936a719"
      }
    }
  }
}
---
# JSON contract validator

This extension executes its pinned capability-limited component, not a model or command. Select exact inputs and assertions with `--validator-input`; see `references/SDK.md`. It receives immutable input records only and cannot read files, mutate the product or access network, environment, clock or random capabilities. Recommendations are untrusted data converted to ordinary tickets, never executed.

