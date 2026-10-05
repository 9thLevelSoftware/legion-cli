# JSON contract component SDK

`json-contract` is a capability-limited validator, not an agent adapter. Its only
export is the WIT world in `packages/sandbox/native/wit/validator.wit`:

```wit
package legion:validator@1.0.0;
world validator {
    export validate: func(input: string) -> string;
}
```

## Standalone invocation

Create `data/product.json` in the project, for example `{"price":10}`. Create an
operator-selected invocation file outside protected engine controls:

```json
{
  "schemaVersion": "legion-cli-component-invocation/v1",
  "checks": [{
    "id": "json-contract",
    "configuration": {
      "assertions": [{
        "id": "price-positive",
        "predicate": {"file":"data/product.json","pointer":"/price","op":"gt","expected":0}
      }]
    },
    "files": ["data/product.json"]
  }]
}
```

Run `pnpm exec legion-cli skills run extension:json-contract --validator-input invocation.json`.
A component invocation requires this file and rejects `--profile`; it needs no
model. The current manifest read roots are `src`, `data`, `config`, `test`,
`fixtures`, and the exact `package.json` file. The invocation must choose concrete
paths within those roots; protected engine controls and aliases remain denied.
The guest cannot choose source files or evidence paths. A failed assertion may
produce an ordinary `bug`/`P2` recommendation ticket; this does not execute it.

## Predicate semantics

Configuration is exactly `{assertions:[{id,predicate}]}`, with 1–256 unique
lower-case IDs (`^[a-z][a-z0-9-]{0,63}$`). Predicate nesting is at most 16.

- Leaf: `{file,pointer,op,expected}`. The file must be one of the declared raw
  input files. Operations are `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `in`.
- Group: `{op:"all"|"any",children:[...]}` with at least one child.
- Negation: `{op:"not",child:...}`.

JSON pointers use RFC 6901 escaping (`~0` means `~`, `~1` means `/`); `""` selects
the whole document. Array indices are unsigned decimal without leading zeroes
except `0`. `-` does not select an array element. Object keys remain literal.
Equality is recursive and type-preserving: object key order is irrelevant, array
order matters, and a number is not equal to a numeric string or boolean. Numbers
use finite binary64 semantics (`1` equals `1.0`, and `-0` equals `0`). Integral
values outside ±(2^53−1) are errors rather than silently accepted rounding.
Ordered comparisons require numeric operands. `in` requires an expected array and
uses the same equality for its elements.

Every referenced leaf is evaluated. A missing file/pointer, duplicate object key,
invalid JSON/Unicode, unsafe integral number or wrong numeric operand type is an
error that cannot be inverted by `not`, hidden by `any`, or skipped by a prior
`all` failure. All configured assertions must pass for the check to pass. Unknown
configuration fields/operators, duplicate assertion IDs and undeclared file
references are invalid. Up to 32 failed assertions produce deterministic
recommendations titled by assertion ID, in assertion order; passes produce none.

## Building the real first-party component

The source is `packages/sandbox/native/validators/json-contract`. It is a Rust
`no_std` + `alloc` library on `wasm32-unknown-unknown`, with a trap-only panic
handler and no randomized maps. Its pinned dependencies are `wit-bindgen 0.61.1`
(defaults off, `macros,realloc`), `dlmalloc 0.2.14` (`global`) and
`serde_json 1.0.145` (defaults off, `alloc,float_roundtrip`). The shared strict JSON
reader rejects duplicate keys before any business evaluation.

From `packages/sandbox/native`, using the committed Rust 1.96.0 toolchain/lock:

```text
cargo build --locked --release -p legion-wasi-host
cargo build --locked --release -p legion-json-contract --target wasm32-unknown-unknown
cargo build --locked --release -p legion-pack-component
target/release/legion-pack-component target/wasm32-unknown-unknown/release/legion_json_contract.wasm json-contract.component.wasm
```

Use `.exe` for the local Windows packer/host. The packer uses
`wit-component 0.258.3`, embedded WIT metadata and validation enabled, with **no
WASI adapter**, and rejects unresolved component imports. The root
`scripts/build-wasi-host.mjs` performs these builds, copies the actual component
to `assets/json-contract.wasm`, computes its hash and generates `SKILL.md` from
`metadata.json`. Metadata alone is not a runnable extension. The build must also
instantiate the actual result against the empty host linker before release;
compilation alone is not execution evidence. Custom components use this same
no-import WIT world and do not acquire extra authority by changing their code.

## Immutable packet and host boundary

`validate` receives canonical UTF-8 JSON with fields `abi`, `projectCheckId`,
`extensionCheckId`, `acceptanceIds`, `unitIds`, `configuration`, `files`, `units`.
Raw files are `{kind:"file",path,mode,sha256,encoding:"utf8"|"base64",content}` or
`{kind:"missing",path}`. Knowledge units are
`{unitId,path,selector?,syntaxDigest,syntaxProjection}`. Standalone IDs are the
extension check ID and acceptance/unit inputs are empty. Source records are
snapshotted by the host, not embedded into the operator invocation document.

Return exactly `legion-cli-validator-output/v1` with `checkId:"json-contract"`,
`status:"passed"|"failed"`, up to 256 unique `{id,status,code,detail?}` observations
and optional up to 32 `{title,priority?,type?,detail?}` recommendations. Details
are at most 4 KiB; titles are 1–256 characters. Unknown fields fail validation.
Runtime/trap/size failures are host-generated `unavailable`, never guest claims.

The packaged helper runs a fresh process/Engine/Store, safe raw component
compilation and an empty linker. It has no ambient guest filesystem, environment,
process, network, clock or random imports. It checks framed stdin lengths, SHA-256,
UTF-8, unique JSON keys and typed records. Fixed caps are: header 16 KiB, component
16 MiB, input 8 MiB, result 1 MiB, 20 million fuel, 1 MiB Wasm stack, 32 instances,
four 64 MiB linear memories, sixteen 100,000-element tables and a 20-second parent
deadline including compilation. Threads/shared memory are disabled; NaNs are
canonicalized and relaxed SIMD is deterministic. Wasmtime 49.0.2 performs
post-return automatically.

Before parsing a request or creating an Engine, the helper establishes and probes
a Windows Job Object 2 GiB committed-process ceiling, or hard Unix `RLIMIT_AS`
ceiling at startup virtual size plus 2 GiB. The Unix bound is **not an RSS bound**.
A non-enforcing/missing native boundary refuses execution. Wasmtime reserves
64 MiB per linear memory with 64 KiB guards and zero extra growth reservation.
Runtime identity binds the binary hash, actual target, ABI, version, verified
guard kind and the fixed settings digest. These controls bound execution; they do
not prove generated-code correctness or the honesty of a custom validator.
