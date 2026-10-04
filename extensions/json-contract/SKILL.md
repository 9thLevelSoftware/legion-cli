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
        "sha256": "32b51a1486ea078d8ec3941a52b0d6f7f2b8e6b095c702af60ce1c809ba58e87"
      }
    }
  }
}
---
# JSON contract validator

This extension executes its pinned capability-limited component, not a model or command. Select exact inputs and assertions with `--validator-input`; see `references/SDK.md`. It receives immutable input records only and cannot read files, mutate the product or access network, environment, clock or random capabilities. Recommendations are untrusted data converted to ordinary tickets, never executed.

