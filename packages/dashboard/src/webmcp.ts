/** Served only when flags.webmcp is true. Not a polyfill. */
export const WEBMCP_SCRIPT_PATH = "/webmcp.js";

export const WEBMCP_TOOLS = [
  "filter_board",
  "open_task",
  "show_timeline",
  "highlight_blockers",
] as const;

export type WebmcpToolName = (typeof WEBMCP_TOOLS)[number];

/** Origin-keyed agent cluster (WebMCP draft); only sent when flags.webmcp. */
export function webmcpHeaders(): Record<string, string> {
  return {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Origin-Agent-Cluster": "?1",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/**
 * Feature-detects document.modelContext.registerTool and registers UI-only
 * tools. registerTool may throw without an origin-keyed cluster — catch and
 * leave the HTTP page unchanged.
 */
export const WEBMCP_SCRIPT = `"use strict";
(function () {
  var modelContext = document.modelContext;
  var registerTool = modelContext && modelContext.registerTool;
  if (typeof registerTool !== "function") return;

  function findTask(id) {
    var nodes = document.querySelectorAll("[data-task]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute("data-task") === id) return nodes[i];
    }
    return null;
  }

  function tools() {
    return [
      {
        name: "filter_board",
        description: "Filter kanban cards by status and text. UI only; does not change Legion CLI state.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", description: "kanban column status" },
            query: { type: "string", description: "text to match on the card" }
          }
        },
        annotations: { readOnlyHint: true },
        execute: function (input) {
          var status = input && input.status;
          var query = input && input.query ? String(input.query).toLowerCase() : "";
          var cards = document.querySelectorAll("[data-task]");
          for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var matchStatus = !status || card.getAttribute("data-status") === status;
            var text = (card.textContent || "").toLowerCase();
            var matchQuery = !query || text.indexOf(query) !== -1;
            card.hidden = !(matchStatus && matchQuery);
          }
          return { ok: true };
        }
      },
      {
        name: "open_task",
        description: "Scroll to and highlight a task card. UI only; does not change Legion CLI state.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "task id" } },
          required: ["id"]
        },
        annotations: { readOnlyHint: true },
        execute: function (input) {
          var id = input && input.id;
          var card = id ? findTask(String(id)) : null;
          if (!card) return { ok: false, error: "not found" };
          if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center" });
          card.classList.add("current");
          return { ok: true, id: String(id) };
        }
      },
      {
        name: "show_timeline",
        description: "Scroll the timeline into view. UI only; does not change Legion CLI state.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: function () {
          var el = document.getElementById("timeline");
          if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
          return { ok: true };
        }
      },
      {
        name: "highlight_blockers",
        description: "Highlight blocked task cards. UI only; does not change Legion CLI state.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: function () {
          var cards = document.querySelectorAll('[data-status="blocked"]');
          for (var i = 0; i < cards.length; i++) cards[i].classList.add("current");
          var el = document.getElementById("blockers");
          if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
          return { ok: true };
        }
      }
    ];
  }

  var list = tools();
  for (var t = 0; t < list.length; t++) {
    try {
      var result = registerTool.call(modelContext, list[t]);
      if (result && typeof result.then === "function") result.catch(function () {});
    } catch (err) {}
  }
})();
`.trimStart();
