# Release checks

- Confirm package and binary versions agree with the candidate tag policy.
- Inspect packed artifacts for required files and excluded source, secrets, and workspace links.
- Install packed artifacts in a clean local consumer and run one supported command.
- Record checksums for the exact candidate artifacts.
- Record Linux, macOS, and Windows evidence independently.
- Record signing, provenance, registry, and external-runner checks as unavailable until observed.
