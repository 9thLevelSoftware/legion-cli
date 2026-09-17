/** Stdio LSP 3.17 mock: initialize → documentSymbol (two depth-0 Functions). */

function encode(msg) {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

const DEPTH0_FUNCTIONS = [
  {
    name: "alpha",
    kind: 12,
    range: RANGE,
    selectionRange: RANGE,
    children: [{ name: "nested", kind: 12, range: RANGE, selectionRange: RANGE }],
  },
  { name: "beta", kind: 12, range: RANGE, selectionRange: RANGE },
];

function handle(msg) {
  if (msg.method === "initialize") {
    encode({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: { documentSymbolProvider: true, textDocumentSync: 1 },
        serverInfo: { name: "legion-mock-lsp", version: "0.0.0" },
      },
    });
    return;
  }
  if (msg.method === "initialized" || msg.method === "textDocument/didOpen") return;
  if (msg.method === "exit") {
    process.exit(0);
    return;
  }
  if (msg.method === "textDocument/documentSymbol") {
    encode({ jsonrpc: "2.0", id: msg.id, result: DEPTH0_FUNCTIONS });
    return;
  }
  if (msg.method === "shutdown") {
    encode({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.id !== undefined) encode({ jsonrpc: "2.0", id: msg.id, result: null });
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, Buffer.from(chunk)]);
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + length) break;
    const body = buf.subarray(bodyStart, bodyStart + length).toString("utf8");
    buf = buf.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
