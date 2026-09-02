import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AssumptionSchema,
  ContextFileSchema,
  DiscussFileSchema,
  IngestReceiptSchema,
  IntentAnswersFileSchema,
  LegionConfigSchema,
  ProjectFileSchema,
  SpecSchema,
  StateFileSchema,
  TaskSchema,
} from "@9thlevelsoftware/legion-cli-schema";
import type {
  Assumption,
  ContextFile,
  DiscussFile,
  IngestReceipt,
  IntentAnswersFile,
  LegionConfig,
  ProjectFile,
  Spec,
  StateFile,
  Task,
} from "@9thlevelsoftware/legion-cli-schema";
import type { ZodType } from "zod";
import { PersistError } from "./errors.js";
import { commitIngest, isGitRepo } from "./git.js";
import { ingestFiles, type IngestDocument } from "./ingest.js";
import {
  assumptionPath,
  decisionPath,
  ingestReceiptPath,
  legionPaths,
  specPath,
  taskPath,
  type LegionPaths,
} from "./layout.js";
import { acquireEngineLock, type HeldLock } from "./lock.js";
import {
  readMarkdownFile,
  readYamlFile,
  writeMarkdownFile,
  writeYamlFile,
  type MarkdownDoc,
} from "./markdown.js";
import { toFsPath } from "./paths.js";
import { rebuildIndex } from "./sqlite.js";
import { DecisionFileSchema, WikiPageSchema, type DecisionFile, type WikiPage } from "./wiki-page.js";

export interface LegionReader {
  readonly projectRoot: string;
  readonly paths: LegionPaths;
  readProject(): Promise<MarkdownDoc<ProjectFile>>;
  readState(): Promise<MarkdownDoc<StateFile>>;
  readContext(): Promise<MarkdownDoc<ContextFile>>;
  readConfig(): Promise<LegionConfig>;
  readIntentAnswers(): Promise<IntentAnswersFile>;
  readSpec(specId: string): Promise<MarkdownDoc<Spec>>;
  readTask(taskId: string): Promise<MarkdownDoc<Task>>;
  readDiscuss(): Promise<MarkdownDoc<DiscussFile>>;
  readAssumption(id: string): Promise<MarkdownDoc<Assumption>>;
  readDecision(fileName: string): Promise<MarkdownDoc<DecisionFile>>;
  readWikiPage(storePath: string): Promise<MarkdownDoc<WikiPage>>;
}

export class LegionStore implements LegionReader {
  readonly projectRoot: string;
  readonly paths: LegionPaths;
  #lock: HeldLock | null = null;
  #lockDepth = 0;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.paths = legionPaths(this.projectRoot);
  }

  async acquireLock(opts?: { timeoutMs?: number }): Promise<void> {
    if (this.#lockDepth > 0) {
      this.#lockDepth += 1;
      return;
    }
    this.#lock = await acquireEngineLock(this.paths.lock, opts);
    this.#lockDepth = 1;
  }

  async releaseLock(): Promise<void> {
    if (this.#lockDepth === 0) return;
    this.#lockDepth -= 1;
    if (this.#lockDepth === 0 && this.#lock) {
      const lock = this.#lock;
      this.#lock = null;
      await lock.release();
    }
  }

  async withLock<T>(fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
    await this.acquireLock(opts);
    try {
      return await fn();
    } finally {
      await this.releaseLock();
    }
  }

  async pathExists(storePath: string): Promise<boolean> {
    try {
      await access(toFsPath(this.projectRoot, storePath));
      return true;
    } catch {
      return false;
    }
  }

  readMarkdown<T>(storePath: string, schema: ZodType<T>): Promise<MarkdownDoc<T>> {
    return readMarkdownFile(toFsPath(this.projectRoot, storePath), storePath, schema);
  }

  writeMarkdown(storePath: string, data: unknown, body: string): Promise<void> {
    return this.withLock(() => writeMarkdownFile(toFsPath(this.projectRoot, storePath), data, body));
  }

  readYaml<T>(storePath: string, schema: ZodType<T>): Promise<T> {
    return readYamlFile(toFsPath(this.projectRoot, storePath), storePath, schema);
  }

  writeYaml(storePath: string, data: unknown): Promise<void> {
    return this.withLock(() => writeYamlFile(toFsPath(this.projectRoot, storePath), data));
  }

  readProject(): Promise<MarkdownDoc<ProjectFile>> {
    return readMarkdownFile(this.paths.projectMd, ".legion-cli/PROJECT.md", ProjectFileSchema);
  }
  writeProject(data: ProjectFile, body: string): Promise<void> {
    return this.writeMarkdown(".legion-cli/PROJECT.md", data, body);
  }

  readState(): Promise<MarkdownDoc<StateFile>> {
    return readMarkdownFile(this.paths.stateMd, ".legion-cli/STATE.md", StateFileSchema);
  }
  writeState(data: StateFile, body: string): Promise<void> {
    return this.writeMarkdown(".legion-cli/STATE.md", data, body);
  }

  readContext(): Promise<MarkdownDoc<ContextFile>> {
    return readMarkdownFile(this.paths.contextMd, ".legion-cli/CONTEXT.md", ContextFileSchema);
  }
  writeContext(data: ContextFile, body: string): Promise<void> {
    return this.writeMarkdown(".legion-cli/CONTEXT.md", data, body);
  }

  readConfig(): Promise<LegionConfig> {
    return readYamlFile(this.paths.configYaml, ".legion-cli/config.yaml", LegionConfigSchema);
  }
  writeConfig(data: LegionConfig): Promise<void> {
    return this.writeYaml(".legion-cli/config.yaml", data);
  }

  readIntentAnswers(): Promise<IntentAnswersFile> {
    return readYamlFile(
      this.paths.intentAnswers,
      ".legion-cli/wiki/product/intent-answers.yaml",
      IntentAnswersFileSchema,
    );
  }
  writeIntentAnswers(data: IntentAnswersFile): Promise<void> {
    return this.writeYaml(".legion-cli/wiki/product/intent-answers.yaml", data);
  }

  readSpec(specId: string): Promise<MarkdownDoc<Spec>> {
    const store = specPath(specId);
    return readMarkdownFile(toFsPath(this.projectRoot, store), store, SpecSchema);
  }
  writeSpec(data: Spec, body: string): Promise<void> {
    return this.writeMarkdown(specPath(data.id), data, body);
  }

  readTask(taskId: string): Promise<MarkdownDoc<Task>> {
    const store = taskPath(taskId);
    return readMarkdownFile(toFsPath(this.projectRoot, store), store, TaskSchema);
  }
  writeTask(data: Task, body: string): Promise<void> {
    return this.writeMarkdown(taskPath(data.id), data, body);
  }

  readDiscuss(): Promise<MarkdownDoc<DiscussFile>> {
    return readMarkdownFile(this.paths.discussMd, ".legion-cli/discuss/DISCUSS.md", DiscussFileSchema);
  }
  writeDiscuss(data: DiscussFile, body: string): Promise<void> {
    return this.writeMarkdown(".legion-cli/discuss/DISCUSS.md", data, body);
  }

  readAssumption(id: string): Promise<MarkdownDoc<Assumption>> {
    const store = assumptionPath(id);
    return readMarkdownFile(toFsPath(this.projectRoot, store), store, AssumptionSchema);
  }
  writeAssumption(data: Assumption, body: string): Promise<void> {
    return this.writeMarkdown(assumptionPath(data.id), data, body);
  }

  readDecision(fileName: string): Promise<MarkdownDoc<DecisionFile>> {
    const store = decisionPath(fileName);
    return readMarkdownFile(toFsPath(this.projectRoot, store), store, DecisionFileSchema);
  }
  writeDecision(fileName: string, data: DecisionFile, body: string): Promise<void> {
    return this.writeMarkdown(decisionPath(fileName), data, body);
  }

  readWikiPage(storePath: string): Promise<MarkdownDoc<WikiPage>> {
    return readMarkdownFile(toFsPath(this.projectRoot, storePath), storePath, WikiPageSchema);
  }

  readIngestReceipt(id: string): Promise<MarkdownDoc<IngestReceipt>> {
    const store = ingestReceiptPath(id);
    return readMarkdownFile(toFsPath(this.projectRoot, store), store, IngestReceiptSchema);
  }

  rebuild(): Promise<void> {
    return this.withLock(() => rebuildIndex(this.projectRoot));
  }

  ingest(
    sources: string[],
    opts?: { noCommit?: boolean; documents?: IngestDocument[] },
  ): Promise<IngestReceipt> {
    return this.withLock(async () => {
      if (!opts?.noCommit && !isGitRepo(this.projectRoot)) {
        throw new PersistError("ingest auto-commit requires a git repository");
      }
      const receipt = await ingestFiles({
        projectRoot: this.projectRoot,
        sources,
        documents: opts?.documents,
        wikiExists: (storePath) => this.pathExists(storePath),
        readWikiPage: async (storePath) => {
          try {
            return await this.readWikiPage(storePath);
          } catch {
            return null;
          }
        },
        writeWikiPage: (storePath, data, body) =>
          writeMarkdownFile(toFsPath(this.projectRoot, storePath), data, body),
        writeReceipt: (storePath, data, body) =>
          writeMarkdownFile(toFsPath(this.projectRoot, storePath), data, body),
      });
      await rebuildIndex(this.projectRoot);
      if (!opts?.noCommit) {
        commitIngest(this.projectRoot, receipt);
      }
      return receipt;
    });
  }

  writeWikiPage(storePath: string, data: WikiPage, body: string): Promise<void> {
    return this.writeMarkdown(storePath, data, body);
  }
}

export function createLegionStore(projectRoot: string): LegionStore {
  return new LegionStore(projectRoot);
}
