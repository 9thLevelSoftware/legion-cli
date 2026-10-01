# Disposable rehearsal protocol

1. Prove the target is disposable and record its identity without credentials.
2. Seed representative fixtures and record a stable logical fingerprint.
3. Apply the migration once and verify reads, writes, constraints, and expected shape.
4. Execute the documented rollback or restore path.
5. Verify the original logical fingerprint and application behavior.
6. Apply the forward migration again to test idempotency and ordering.
7. Preserve command exits and sanitized logs as evidence artifacts.
