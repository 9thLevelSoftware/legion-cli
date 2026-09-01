import { createInterface, type Interface } from "node:readline/promises";

let shared: Interface | undefined;
let piped: string[] | undefined;
let slurped = false;

function tty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function rl(): Interface {
  shared ??= createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty(),
  });
  return shared;
}

/** Drain piped stdin up front so later awaits cannot miss it. */
export async function slurpStdin(): Promise<void> {
  if (slurped || tty()) return;
  slurped = true;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  piped = text.length === 0 ? [] : text.split(/\r?\n/);
  if (piped.length > 0 && piped[piped.length - 1] === "") piped.pop();
}

export async function promptIfTty(question: string): Promise<string | undefined> {
  if (!tty()) return undefined;
  return (await rl().question(question)).trim();
}

/** Read a line from TTY or piped stdin. */
export async function readLine(question: string): Promise<string> {
  if (tty()) {
    return (await rl().question(question)).trim();
  }
  await slurpStdin();
  process.stdout.write(question);
  if (!piped || piped.length === 0) return "";
  return (piped.shift() ?? "").trim();
}

export function closePrompt(): void {
  shared?.close();
  shared = undefined;
  piped = undefined;
  slurped = false;
}

export function isYes(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

export function isNo(answer: string): boolean {
  return /^(n|no)$/i.test(answer.trim());
}
