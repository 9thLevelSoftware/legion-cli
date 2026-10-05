import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { assertAgentPathAllowed, assertNoLinkInPath, canonicalJson } from "@9thlevelsoftware/legion-cli-persist";
import { AssurancePathSchema, ComponentUnitInputSchema, KnowledgeSelectorSchema } from "@9thlevelsoftware/legion-cli-schema";
import type { AssurancePlan, ComponentInput, KnowledgeSelector } from "@9thlevelsoftware/legion-cli-schema";
import type * as ts from "typescript";

export type KnowledgeBindingResult =
  | { status: "bound"; input: ComponentInput["units"][number]; source: { path: string; sha256: string; mode: string }; parserVersion: string | null }
  | { status: "unknown"; unitId: string; path: string; reason: string; source: { path: string; sha256: string | null; mode: string | null }; parserVersion: string | null };

const MAX_BYTES = 8 * 1024 * 1024;
const PARSER_VERSION = "typescript@5.8.3";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
let parserPromise: Promise<typeof ts> | undefined;

interface Snapshot {
  bytes: Buffer;
  stat: Stats;
  physical: string;
}

function sameFile(left: Stats, right: Stats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function admitCurrent(root: string, path: string, snapshot: Snapshot): Promise<void> {
  await assertAgentPathAllowed(root, path);
  const absolute = resolve(root, ...path.split("/"));
  await assertNoLinkInPath(absolute, { root });
  if (await realpath(absolute) !== snapshot.physical || !sameFile(snapshot.stat, await lstat(absolute))) {
    throw new Error("Knowledge source changed during binding");
  }
}

async function snapshotSource(root: string, path: string): Promise<Snapshot> {
  await assertAgentPathAllowed(root, path);
  const absolute = resolve(root, ...path.split("/"));
  await assertNoLinkInPath(absolute, { root });
  const physical = await realpath(absolute);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Knowledge source must be a regular non-linked file");
  if (before.size > MAX_BYTES) throw new Error("Knowledge source exceeds 8 MiB");
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!sameFile(before, stat)) throw new Error("Knowledge source changed while opening");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("Knowledge source changed while reading");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.allocUnsafe(1), 0, 1, offset)).bytesRead !== 0 || !sameFile(stat, await handle.stat())) {
      throw new Error("Knowledge source changed during snapshot");
    }
    const snapshot = { bytes, stat, physical };
    await admitCurrent(root, path, snapshot);
    return snapshot;
  } finally {
    await handle.close();
  }
}

interface Candidate { node: ts.Node; parent: ts.Node; }

function declarationName(parser: typeof ts, node: ts.Node): string | undefined {
  const name = (node as ts.NamedDeclaration).name;
  if (name && (parser.isIdentifier(name) || parser.isPrivateIdentifier(name) || parser.isStringLiteral(name) || parser.isNumericLiteral(name))) return name.text;
  return undefined;
}

function selectorNodes(parser: typeof ts, file: ts.SourceFile, selector: KnowledgeSelector): ts.Node[] {
  const candidates: Candidate[] = [];
  const scopeDeclarations = new Map<string, ts.Node[]>();
  const pending: { node: ts.Node; scope: string[] }[] = [{ node: file, scope: [] }];
  while (pending.length) {
    const { node, scope } = pending.pop()!;
    const name = declarationName(parser, node);
    const kind = parser.isFunctionDeclaration(node) || parser.isFunctionExpression(node) ? "function" : parser.isClassDeclaration(node) || parser.isClassExpression(node) ? "class" :
      parser.isMethodDeclaration(node) || parser.isMethodSignature(node) ? "method" : parser.isTypeAliasDeclaration(node) ? "type" :
      parser.isInterfaceDeclaration(node) ? "interface" : parser.isVariableDeclaration(node) && parser.isIdentifier(node.name) ? "variable" : undefined;
    if (kind === selector.kind && name !== undefined && [...scope, name].join(".") === selector.qualifiedName) {
      candidates.push({ node, parent: node.parent });
    }
    const namedScope = parser.isModuleDeclaration(node) || parser.isFunctionDeclaration(node) || parser.isClassDeclaration(node) ||
      parser.isInterfaceDeclaration(node) || parser.isTypeAliasDeclaration(node) || parser.isMethodDeclaration(node) ||
      parser.isVariableDeclaration(node) || parser.isFunctionExpression(node) || parser.isClassExpression(node);
    if (namedScope && name !== undefined && !parser.isModuleDeclaration(node)) {
      const qualified = [...scope, name].join(".");
      const declarations = scopeDeclarations.get(qualified) ?? [];
      declarations.push(node);
      scopeDeclarations.set(qualified, declarations);
    }
    const anonymousCallable = parser.isArrowFunction(node) || parser.isFunctionExpression(node) || parser.isClassExpression(node);
    if (anonymousCallable && !name && !(parser.isVariableDeclaration(node.parent) && node.parent.initializer === node && parser.isIdentifier(node.parent.name))) continue;
    const nestedScope = namedScope && name !== undefined ? [...scope, name] : scope;
    const children: ts.Node[] = [];
    parser.forEachChild(node, (child) => { children.push(child); });
    for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i]!, scope: nestedScope });
  }
  if (candidates.length === 0) throw new Error(`Selector not found: ${selector.kind} ${selector.qualifiedName}`);
  for (const [qualified, declarations] of scopeDeclarations) {
    if (!selector.qualifiedName.startsWith(`${qualified}.`) || declarations.length < 2) continue;
    const implemented = declarations.filter((node) => (parser.isFunctionDeclaration(node) || parser.isMethodDeclaration(node)) && node.body !== undefined);
    const sameOverloadScope = declarations.every((node) => node.kind === declarations[0]!.kind && node.parent === declarations[0]!.parent) &&
      declarations.every((node) => parser.isFunctionDeclaration(node) || parser.isMethodDeclaration(node));
    if (!sameOverloadScope || implemented.length > 1) throw new Error(`Ambiguous qualified scope: ${qualified}`);
  }
  if (selector.kind !== "function" && selector.kind !== "method") {
    if (candidates.length !== 1) throw new Error(`Ambiguous selector: ${selector.kind} ${selector.qualifiedName}`);
    return [candidates[0]!.node];
  }
  const parent = candidates[0]!.parent;
  if (candidates.some((x) => x.parent !== parent || x.node.kind !== candidates[0]!.node.kind)) throw new Error(`Ambiguous overload scopes: ${selector.qualifiedName}`);
  const nodes = candidates.map((x) => x.node as ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration | ts.MethodSignature);
  const firstStatic = parser.canHaveModifiers(nodes[0]!) && parser.getModifiers(nodes[0]!)?.some((m) => m.kind === parser.SyntaxKind.StaticKeyword) === true;
  if (nodes.some((node) => (parser.canHaveModifiers(node) && parser.getModifiers(node)?.some((m) => m.kind === parser.SyntaxKind.StaticKeyword) === true) !== firstStatic)) throw new Error(`Ambiguous static/instance methods: ${selector.qualifiedName}`);
  const implementations = nodes.filter((node) => "body" in node && node.body !== undefined);
  if (implementations.length > 1) throw new Error(`Duplicate overload implementations: ${selector.qualifiedName}`);
  if (implementations.length === 1 && implementations[0] !== nodes[nodes.length - 1]) throw new Error(`Overload implementation must follow signatures: ${selector.qualifiedName}`);
  const abstract = parser.canHaveModifiers(nodes[0]!) && parser.getModifiers(nodes[0]!)?.some((m) => m.kind === parser.SyntaxKind.AbstractKeyword) === true;
  let ambient = file.isDeclarationFile || parser.isMethodSignature(nodes[0]!);
  for (let node: ts.Node | undefined = nodes[0]; node; node = node.parent) {
    if (parser.canHaveModifiers(node) && parser.getModifiers(node)?.some((m) => m.kind === parser.SyntaxKind.DeclareKeyword)) ambient = true;
  }
  if ((ambient || abstract) && implementations.length > 0) throw new Error(`Ambient or abstract declaration cannot have an implementation: ${selector.qualifiedName}`);
  if (!ambient && !abstract && implementations.length === 0) throw new Error(`Incomplete overload group without implementation: ${selector.qualifiedName}`);
  if (nodes.length > 1) {
    const modifierMask = parser.ModifierFlags.AccessibilityModifier | parser.ModifierFlags.Static | parser.ModifierFlags.Abstract | parser.ModifierFlags.Export | parser.ModifierFlags.Default | parser.ModifierFlags.Ambient;
    const firstModifiers = parser.getCombinedModifierFlags(nodes[0]!) & modifierMask;
    const firstOptional = nodes[0]!.questionToken !== undefined;
    if (nodes.some((node) => (parser.getCombinedModifierFlags(node) & modifierMask) !== firstModifiers || (node.questionToken !== undefined) !== firstOptional)) throw new Error(`Inconsistent overload declaration modifiers: ${selector.qualifiedName}`);
    const siblings: ts.Node[] = [];
    parser.forEachChild(parent, (child) => { siblings.push(child); });
    const first = siblings.indexOf(nodes[0]!);
    if (nodes.some((node, i) => siblings[first + i] !== node)) throw new Error(`Noncontiguous overload group: ${selector.qualifiedName}`);
  }
  return nodes;
}

const OMIT_SCALARS: Record<string, true> = { pos: true, end: true, id: true, transformFlags: true, modifierFlagsCache: true, originalKeywordKind: true, multiLine: true };

type FlatNode = { kind: number; scalars: Record<string, string | number | boolean>; edges: Record<string, number[]>; raw?: string };

function syntaxProjection(parser: typeof ts, file: ts.SourceFile, roots: ts.Node[], selector: KnowledgeSelector): ComponentInput["units"][number]["syntaxProjection"] {
  const nodes: FlatNode[] = [];
  const indices = new Map<ts.Node, number>();
  const queue: ts.Node[] = [];
  function index(node: ts.Node): number {
    const prior = indices.get(node);
    if (prior !== undefined) return prior;
    const next = queue.length;
    indices.set(node, next);
    queue.push(node);
    return next;
  }
  const rootIndices = roots.map(index);
  let projectionBytes = 0;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    const children = new Set<ts.Node>();
    parser.forEachChild(node, (child) => { children.add(child); });
    const scalars: FlatNode["scalars"] = {};
    const edges: FlatNode["edges"] = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "kind" || Object.hasOwn(OMIT_SCALARS, key)) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") scalars[key] = value;
      else if (children.has(value as ts.Node)) edges[key] = [index(value as ts.Node)];
      else if (Array.isArray(value)) {
        const childNodes = value.filter((child): child is ts.Node => children.has(child));
        if (childNodes.length) edges[key] = childNodes.map(index);
      }
    }
    const represented = new Set(Object.values(edges).flat());
    for (const child of children) if (!represented.has(index(child))) throw new Error("Unsupported parser child structure");
    const record: FlatNode = { kind: node.kind, scalars, edges };
    if (parser.isIdentifier(node) || parser.isPrivateIdentifier(node) || parser.isLiteralExpression(node) ||
        parser.isTemplateHead(node) || parser.isTemplateMiddle(node) || parser.isTemplateTail(node) || parser.isJsxText(node)) {
      record.raw = file.text.slice(parser.isJsxText(node) ? node.pos : node.getStart(file), node.end);
    }
    nodes.push(record);
    projectionBytes += Buffer.byteLength(canonicalJson(record)) + 1;
    if (projectionBytes > MAX_BYTES) throw new Error("Knowledge projection exceeds 8 MiB");
  }
  const context: { kind: number; flags: number; modifiers: number[] }[] = [];
  if (selector.kind === "variable") {
    const list = roots[0]!.parent;
    if (parser.isVariableDeclarationList(list)) {
      context.push({ kind: list.kind, flags: list.flags, modifiers: [] });
      const statement = list.parent;
      if (parser.isVariableStatement(statement)) context.push({ kind: statement.kind, flags: statement.flags, modifiers: parser.getModifiers(statement)?.map((m) => m.kind) ?? [] });
    }
  }
  return { format: "legion-knowledge-ast/v1", roots: rootIndices, context, nodes };
}

export async function bindKnowledgeUnit(projectRoot: string, unit: AssurancePlan["knowledge"][number]): Promise<KnowledgeBindingResult> {
  const path = unit.source.path;
  const selector = unit.source.selector;
  const source: { path: string; sha256: string | null; mode: string | null } = { path, sha256: null, mode: null };
  const parserVersion = selector ? PARSER_VERSION : null;
  let root: string | undefined;
  let snapshot: Snapshot | undefined;
  try {
    AssurancePathSchema.parse(path);
    if (selector) KnowledgeSelectorSchema.parse(selector);
    root = await realpath(projectRoot);
    snapshot = await snapshotSource(root, path);
    source.sha256 = createHash("sha256").update(snapshot.bytes).digest("hex");
    source.mode = process.platform === "win32" ? `native:${(snapshot.stat.mode & 0o777).toString(8).padStart(3, "0")}` : (snapshot.stat.mode & 0o111) !== 0 ? "100755" : "100644";
    let syntax: ComponentInput["units"][number]["syntaxProjection"];
    if (!selector) {
      let content: string;
      let encoding: "utf8" | "base64";
      try { content = utf8.decode(snapshot.bytes); encoding = "utf8"; }
      catch { content = snapshot.bytes.toString("base64"); encoding = "base64"; }
      syntax = { format: "legion-knowledge-bytes/v1", encoding, content };
    } else {
      const extension = extname(path).toLowerCase();
      if (![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) throw new Error("AST selectors require a TypeScript or JavaScript source; omit selector for whole-file binding");
      const parser = await (parserPromise ??= import("typescript"));
      if (parser.version !== "5.8.3") throw new Error(`Knowledge parser version mismatch: ${parser.version}`);
      const text = utf8.decode(snapshot.bytes);
      const kind = extension === ".tsx" ? parser.ScriptKind.TSX : extension === ".jsx" ? parser.ScriptKind.JSX : [".js", ".mjs", ".cjs"].includes(extension) ? parser.ScriptKind.JS : parser.ScriptKind.TS;
      const file = parser.createSourceFile(path, text, parser.ScriptTarget.Latest, true, kind);
      const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
      if (diagnostics.length) throw new Error(`Source parse error: ${diagnostics.map((d) => `${d.code}: ${parser.flattenDiagnosticMessageText(d.messageText, " ")}`).join("; ")}`);
      syntax = syntaxProjection(parser, file, selectorNodes(parser, file, selector), selector);
    }
    const canonical = canonicalJson(syntax);
    if (Buffer.byteLength(canonical) > MAX_BYTES) throw new Error("Knowledge projection exceeds 8 MiB");
    const input = ComponentUnitInputSchema.parse({ unitId: unit.id, path, ...(selector ? { selector } : {}), syntaxDigest: createHash("sha256").update("legion-knowledge-projection/v1\0").update(canonical).digest("hex"), syntaxProjection: syntax });
    await admitCurrent(root, path, snapshot);
    return { status: "bound", input, source: { path, sha256: source.sha256, mode: source.mode }, parserVersion };
  } catch (error) {
    let reason = error instanceof Error ? error.message : String(error);
    if (root && snapshot) {
      try { await admitCurrent(root, path, snapshot); }
      catch (race) { reason = race instanceof Error ? race.message : String(race); }
    }
    return { status: "unknown", unitId: unit.id, path, reason: reason.slice(0, 4096), source, parserVersion };
  }
}
