import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isGitRepo } from '@9thlevelsoftware/legion-cli-persist';
import { workflowProductFingerprint } from '../packages/core/dist/workflow.js';

// Workload/bytes/case order are fixed; only timing and the temporary isolation path vary.
// This measures conservative whole-product hashing, not model quality or a selective implementation.
const FIXTURE_VERSION = 'evidence-non-git-v1';
const WARMUPS = 2;
const MEASUREMENTS = 7;
const GROUPS = ['api', 'ui', 'worker'];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const groupPaths = (group) => Array.from({ length: 64 }, (_, index) =>
  `packages/${group}/src/input-${String(index).padStart(3, '0')}.js`);
const SHARED_INPUTS = [
  'package.json', 'packages/shared/package.json', 'tsconfig.json', 'pnpm-workspace.yaml',
];
const ADDED_INPUT = 'packages/api/src/added.js';
const RENAMED_INPUT = 'packages/api/src/renamed.js';

// Hand-authored fixture check read sets: shared inputs plus each check's own product inputs.
// Absent add/rename candidates remain explicit paths with null digests. These are NOT task
// contracts/write sets, inferred dependencies, or a claim that production has per-check reuse.
const READ_SETS = {
  api: [...SHARED_INPUTS, ...groupPaths('api'), ADDED_INPUT, RENAMED_INPUT].sort(),
  ui: [...SHARED_INPUTS, ...groupPaths('ui')].sort(),
  worker: [...SHARED_INPUTS, ...groupPaths('worker')].sort(),
};
const baseline = new Map([
  ['package.json', '{"name":"evidence-fixture","private":true,"type":"module","version":"1.0.0"}\n'],
  ['packages/shared/package.json', '{"name":"fixture-shared","type":"module","version":"1.0.0"}\n'],
  ['tsconfig.json', '{"compilerOptions":{"strict":true,"target":"ES2022"}}\n'],
  ['pnpm-workspace.yaml', 'packages:\n  - packages/*\n'],
  ['.legion-cli/receipts.json', '{"fixture":"baseline"}\n'],
  ['dist/output.js', 'export const generated = "baseline";\n'],
  ['packages/ui/build/output.js', 'export const generated = "baseline";\n'],
]);
for (const group of [...GROUPS, 'unrelated']) {
  for (const [index, path] of groupPaths(group).entries()) {
    baseline.set(path, `// Fixed product input ${group}/${index}; no host paths or timestamps.\n`
      + `export const input = ${index};\nexport const group = "${group}";\n`
      + 'export function evaluate(value) { return value + input; }\n');
  }
}

async function put(root, path, body) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, { mode: 0o644 });
}
async function reset(root) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root);
  for (const [path, body] of baseline) await put(root, path, body);
}
async function edit(root, path) {
  assert.ok(baseline.has(path), `edit must target a baseline file: ${path}`);
  await put(root, path, `${baseline.get(path)}\n// Fixed independent mutation.\n`);
}

const CASES = [
  { name: 'unchanged', impacted: [], changed: false, mutate: async () => {} },
  ...GROUPS.map((group) => ({
    name: `${group}-edit`, impacted: [group], changed: true,
    mutate: (root) => edit(root, groupPaths(group)[0]),
  })),
  ...SHARED_INPUTS.map((path) => ({
    name: `shared-${path.replaceAll('/', '-')}`, impacted: GROUPS, changed: true,
    mutate: (root) => edit(root, path),
  })),
  {
    name: 'unrelated-product-edit', impacted: [], changed: true,
    mutate: (root) => edit(root, groupPaths('unrelated')[0]),
  },
  {
    name: 'included-add', impacted: ['api'], changed: true,
    mutate: (root) => put(root, ADDED_INPUT, 'export const added = 1;\n'),
  },
  {
    name: 'included-delete', impacted: ['api'], changed: true,
    mutate: (root) => rm(join(root, groupPaths('api')[0])),
  },
  {
    name: 'included-rename', impacted: ['api'], changed: true,
    mutate: (root) => rename(join(root, groupPaths('api')[0]), join(root, RENAMED_INPUT)),
  },
  {
    name: 'bookkeeping-noise', impacted: [], changed: false,
    mutate: async (root) => {
      await edit(root, '.legion-cli/receipts.json');
      await put(root, '.legion-cli/audit/new.json', '{"fixture":"noise"}\n');
    },
  },
  {
    name: 'dist-noise', impacted: [], changed: false,
    mutate: async (root) => {
      await edit(root, 'dist/output.js');
      await put(root, 'packages/worker/dist/new.js', 'export const noise = 1;\n');
    },
  },
  {
    name: 'build-noise', impacted: [], changed: false,
    mutate: async (root) => {
      await edit(root, 'packages/ui/build/output.js');
      await put(root, 'build/new.js', 'export const noise = 1;\n');
    },
  },
];

const digest = (value) => createHash('sha256').update(value).digest('hex');
async function oracle(root) {
  const result = {};
  for (const group of GROUPS) {
    const inputs = [];
    for (const path of READ_SETS[group]) {
      let contentDigest;
      try {
        contentDigest = digest(await readFile(join(root, path)));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        contentDigest = null;
      }
      inputs.push({ path, sha256: contentDigest });
    }
    result[group] = digest(JSON.stringify(inputs));
  }
  return result;
}
function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function run() {
  assert.ok(parseInt(process.versions.node, 10) >= 22, 'Node.js 22+ is required');
  assert.equal(CASES.length, 15, 'fixed independent case count');
  assert.equal(baseline.size, 263, '256 product files, four shared inputs, three ignored files');
  const temporary = await mkdtemp(join(tmpdir(), 'legion-evidence-'));
  let output;
  try {
    const insideRepo = relative(repoRoot, temporary);
    assert.ok(isAbsolute(insideRepo) || insideRepo === '..' || insideRepo.startsWith(`..${sep}`),
      'OS temporary directory must be outside the repository');
    const root = join(temporary, 'product');
    await reset(root);
    assert.equal(isGitRepo(root), false, 'fixture must use the real non-Git fingerprint path');
    let calls = 0;
    const fingerprint = async () => {
      calls += 1;
      return workflowProductFingerprint(root, []);
    };
    const baselineHash = await fingerprint();
    assert.match(baselineHash, /^[a-f0-9]{64}$/);
    assert.equal(await fingerprint(), baselineHash, 'baseline hash must be repeatable');
    const baselineOracle = await oracle(root);
    const timings = [];
    const summaries = [];
    let unsafeReuses = 0;
    let conservativeInvalidations = 0;
    let unaffectedPairs = 0;
    let safelyReusedPairs = 0;

    for (const scenario of CASES) {
      // Recreate exact baseline paths/bytes/modes: independent cases, never cumulative edits.
      await reset(root);
      await scenario.mutate(root);
      const stateOracle = await oracle(root);
      const impacted = GROUPS.filter((group) => stateOracle[group] !== baselineOracle[group]);
      assert.deepEqual(impacted, scenario.impacted, `${scenario.name}: read-set oracle impact`);
      const stateHash = await fingerprint();
      const globallyChanged = stateHash !== baselineHash;
      assert.equal(globallyChanged, scenario.changed,
        `${scenario.name}: every included mutation changes the global hash; ignored noise does not`);
      for (let index = 0; index < WARMUPS; index += 1) {
        assert.equal(await fingerprint(), stateHash, `${scenario.name}: warmup hash stability`);
      }
      for (let index = 0; index < MEASUREMENTS; index += 1) {
        calls += 1;
        // Only the real fingerprint call is timed. Setup/oracle/assertions/output are excluded.
        const start = performance.now();
        const measuredHash = await workflowProductFingerprint(root, []);
        const elapsed = performance.now() - start;
        assert.ok(Number.isFinite(elapsed) && elapsed >= 0, 'finite fingerprint duration');
        assert.equal(measuredHash, stateHash, `${scenario.name}: timed/untimed hash equivalence`);
        timings.push(elapsed);
      }
      assert.equal(await fingerprint(), stateHash, `${scenario.name}: post-measurement stability`);
      for (const group of GROUPS) {
        if (impacted.includes(group)) {
          if (!globallyChanged) unsafeReuses += 1;
        } else {
          unaffectedPairs += 1;
          if (globallyChanged) conservativeInvalidations += 1;
          else safelyReusedPairs += 1;
        }
      }
      summaries.push(`CASE ${scenario.name} global=${globallyChanged ? 'changed' : 'unchanged'} oracle=${impacted.join(',') || 'none'}`);
    }

    assert.equal(unsafeReuses, 0, 'global unchanged decisions must never reuse impacted checks');
    assert.equal(calls, 2 + CASES.length * (WARMUPS + MEASUREMENTS + 2));
    assert.equal(timings.length, CASES.length * MEASUREMENTS);
    assert.equal(unaffectedPairs, 27, 'fixed oracle-unaffected check/case pairs');
    assert.equal(safelyReusedPairs + conservativeInvalidations, unaffectedPairs);
    timings.sort((left, right) => left - right);
    // Global changed means all three checks would be rechecked. These are diagnostic decisions,
    // not executed checks or production selective reuse. Safe reuse excludes impacted pairs.
    const metrics = {
      fingerprint_median_ms: median(timings),
      fingerprint_p95_ms: timings[Math.ceil(timings.length * 0.95) - 1],
      unsafe_reuses: unsafeReuses,
      conservative_invalidations: conservativeInvalidations,
      safe_reuse_pct: 100 * safelyReusedPairs / unaffectedPairs,
      cases: CASES.length,
      fingerprint_calls: calls,
    };
    for (const value of Object.values(metrics)) assert.ok(Number.isFinite(value), 'finite metric');
    output = [
      ...Object.entries(metrics).map(([name, value]) => `METRIC ${name}=${value}`),
      `ASI node_version=${process.version}`,
      `ASI platform=${process.platform}`,
      `ASI fixture_version=${FIXTURE_VERSION}`,
      ...summaries,
    ].join('\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  // Cleanup must succeed before any success metrics become visible.
  console.log(output);
}

run().catch((error) => {
  console.error(`autoresearch: ${error.stack ?? error}`);
  process.exitCode = 1;
});
