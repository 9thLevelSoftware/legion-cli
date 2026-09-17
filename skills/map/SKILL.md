---
name: map
description: >
  Optional rewrite of human-editable architecture notes under .legion-cli/map/**.
  Fingerprints and the generated region are in-process. Activated only by
  `legion-cli map` when a spawnable adapter exists. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: map
    required: false
    allowedRootsRef: SKILL_CONTRACTS.map
---

# map

Optional notes under `.legion-cli/map/**`.

`legion-cli map` generates `.legion-cli/map/ARCHITECTURE.md` and `fingerprints.json` in-process. This skill is optional. The engine still writes the map when this skill does not spawn.

## Contract

Allowed roots:

- `.legion-cli/map/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.
Do not write product code (`src/**`). The engine reverts extras vs this SkillContract.

The engine, not this spawn, writes `STATE.md` and fingerprint hashes.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

You may rewrite human-editable sections of `.legion-cli/map/ARCHITECTURE.md` **outside** the generated markers:

```
<!-- legion-cli:generated:start -->
…
<!-- legion-cli:generated:end -->
```

Do not remove those markers. Do not rewrite the block between them. `--refresh` preserves prose outside them.

Do not invent module lists; the generated region is the SoT for fingerprints.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
