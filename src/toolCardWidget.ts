export const TOOL_CARD_URI = "ui://widget/least-tool-card-v8.html";
/** Older builds pointed tools at v9; keep serving the same HTML for cached ChatGPT apps. */
export const TOOL_CARD_URI_ALIASES = ["ui://widget/least-tool-card-v9.html"] as const;
export const TOOL_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export const toolCardWidgetHtml = String.raw`
<div id="root" class="wrap">
  <article class="card pending">
    <div class="rail"></div>
    <header class="head">
      <span class="glyph">L</span>
      <div class="headline">
        <div class="title">Least</div>
        <div class="subtitle">Waiting for tool result...</div>
      </div>
      <span class="pill frost">waiting</span>
    </header>
    <div class="skeleton">
      <span></span>
      <span></span>
      <span></span>
    </div>
  </article>
</div>

<style>
  :root {
    color-scheme: dark;
    --nord0: #030407;
    --nord1: #06080c;
    --nord2: #0a0d12;
    --nord3: #0f131a;
    --nord4: #151b24;
    --nord5: #7b8799;
    --nord6: #a3afc0;
    --nord7: #c8d0dc;
    --nord8: #7ab8b6;
    --nord9: #6fa8b8;
    --nord10: #6d8faa;
    --nord11: #4d6d8c;
    --nord12: #a85b64;
    --nord13: #b06f5a;
    --nord14: #c4a86a;
    --nord15: #7fa070;
    --nord16: #9a7a9e;
    --line: rgba(77, 109, 140, 0.2);
    --line-strong: rgba(77, 109, 140, 0.32);
    --shadow: rgba(0, 0, 0, 0.72);
    --glow: rgba(122, 184, 182, 0.16);
    --mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Monaco, Consolas, monospace;
    --sans: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    background: transparent;
    color: var(--nord7);
    font: 12px/1.5 var(--sans);
  }

  .wrap {
    width: 100%;
    padding: 1px;
    background:
      radial-gradient(circle at 16px 10px, rgba(122, 184, 182, 0.08), transparent 160px),
      radial-gradient(circle at calc(100% - 16px) 0, rgba(77, 109, 140, 0.12), transparent 180px),
      var(--nord0);
  }

  .card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 14px;
    background:
      linear-gradient(145deg, rgba(21, 27, 36, 0.86), rgba(3, 4, 7, 0.96)),
      var(--nord1);
    box-shadow: 0 16px 40px var(--shadow), inset 0 1px 0 rgba(200, 208, 220, 0.04);
    animation: least-card-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  .card::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(90deg, rgba(122, 184, 182, 0.07), transparent 22%, transparent 78%, rgba(77, 109, 140, 0.05)),
      radial-gradient(circle at 78% -10%, var(--glow), transparent 160px);
    opacity: 0.9;
  }

  .rail {
    position: absolute;
    inset: 0 auto 0 0;
    width: 4px;
    background: linear-gradient(180deg, var(--nord8), var(--nord11));
    box-shadow: 0 0 18px rgba(122, 184, 182, 0.34);
    opacity: 0.9;
  }

  .card.state-good .rail { background: linear-gradient(180deg, var(--nord15), var(--nord8)); }
  .card.state-warn .rail { background: linear-gradient(180deg, var(--nord14), var(--nord13)); }
  .card.state-bad .rail { background: linear-gradient(180deg, var(--nord12), var(--nord13)); }

  .head {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 58px;
    padding: 12px 14px 11px 16px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, rgba(15, 19, 26, 0.94), rgba(6, 8, 12, 0.86));
  }

  .glyph {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    background: linear-gradient(145deg, var(--nord3), var(--nord1));
    color: var(--nord8);
    font: 10px/1 var(--mono);
    font-weight: 800;
    letter-spacing: -0.02em;
    box-shadow: inset 0 1px 0 rgba(200, 208, 220, 0.05), 0 0 0 3px rgba(122, 184, 182, 0.03);
  }

  .headline { min-width: 0; }

  .title {
    overflow: hidden;
    color: var(--nord7);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtitle {
    overflow: hidden;
    margin-top: 2px;
    color: var(--nord5);
    font-size: 11px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 5px;
    min-width: 0;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    max-width: 24ch;
    overflow: hidden;
    padding: 2px 8px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(15, 19, 26, 0.95), rgba(6, 8, 12, 0.95));
    color: var(--nord5);
    font-size: 10px;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill.good { color: var(--nord15); border-color: rgba(127, 160, 112, 0.35); background: #0c120d; }
  .pill.bad { color: var(--nord12); border-color: rgba(168, 91, 100, 0.35); background: #120a0b; }
  .pill.frost { color: var(--nord9); border-color: rgba(111, 168, 184, 0.35); background: #0a1014; }
  .pill.warn { color: var(--nord14); border-color: rgba(196, 168, 106, 0.35); background: #12100a; }
  .pill.accent { color: var(--nord8); border-color: rgba(122, 184, 182, 0.35); background: #0a1111; }
  .pill.muted { color: var(--nord10); border-color: var(--line); background: var(--nord2); }

  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--nord0);
  }

  .strip-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    padding: 2px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--nord2);
    color: var(--nord6);
    font-size: 10px;
    font-weight: 650;
  }

  .strip-key {
    color: var(--nord10);
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .body {
    max-height: 460px;
    overflow: auto;
    padding: 12px;
    background:
      linear-gradient(rgba(77, 109, 140, 0.035) 1px, transparent 1px),
      var(--nord1);
    background-size: 100% 28px;
    scrollbar-color: rgba(122, 184, 182, 0.45) rgba(3, 4, 7, 0.25);
    scrollbar-width: thin;
  }

  .body::-webkit-scrollbar { width: 9px; height: 9px; }
  .body::-webkit-scrollbar-track { background: rgba(3, 4, 7, 0.35); }
  .body::-webkit-scrollbar-thumb {
    border: 2px solid rgba(3, 4, 7, 0.8);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(122, 184, 182, 0.72), rgba(77, 109, 140, 0.62));
  }

  .banner {
    display: grid;
    gap: 4px;
    margin-bottom: 10px;
    padding: 10px 11px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--nord2);
    color: var(--nord6);
    font-size: 11px;
  }

  .banner strong { color: var(--nord8); font-weight: 800; }

  .metrics,
  .summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 10px;
  }

  .metric,
  .summary-item {
    min-width: 0;
    padding: 9px 10px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(10, 13, 18, 0.92), rgba(6, 8, 12, 0.9));
    box-shadow: inset 0 1px 0 rgba(200, 208, 220, 0.035);
    transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
  }

  .metric:hover,
  .summary-item:hover {
    transform: translateY(-1px);
    border-color: var(--line-strong);
    background: rgba(15, 19, 26, 0.95);
  }

  .metric .label,
  .summary-label {
    display: block;
    margin-bottom: 4px;
    color: var(--nord10);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .metric .value,
  .summary-value {
    overflow: hidden;
    color: var(--nord7);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    font-weight: 750;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metric .value.small { font-size: 11px; font-weight: 650; }

  .code {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(3, 4, 7, 0.92);
    box-shadow: inset 0 1px 0 rgba(200, 208, 220, 0.025);
  }

  .codebar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 30px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, rgba(15, 19, 26, 0.98), rgba(6, 8, 12, 0.96));
    color: var(--nord10);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  pre {
    margin: 0;
    padding: 10px;
    overflow: visible;
    color: var(--nord6);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .diff-line { display: block; min-height: 18px; padding: 0 4px; border-radius: 3px; }
  .diff-add { color: #9fca8c; background: linear-gradient(90deg, rgba(127, 160, 112, 0.16), transparent 88%); }
  .diff-del { color: #c9737d; background: linear-gradient(90deg, rgba(168, 91, 100, 0.16), transparent 88%); }
  .diff-hunk { color: var(--nord9); }
  .terminal pre { color: var(--nord7); }
  .prompt { color: var(--nord8); font-weight: 800; }

  .section-label {
    margin: 12px 1px 6px;
    color: var(--nord10);
    font-size: 9px;
    font-weight: 850;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .fold {
    margin-top: 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--nord0);
    overflow: hidden;
  }

  .fold > summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    min-height: 36px;
    padding: 8px 10px;
    cursor: pointer;
    color: var(--nord6);
    font-weight: 700;
    list-style: none;
  }

  .fold > summary::-webkit-details-marker { display: none; }

  .fold > summary::after {
    content: "+";
    color: var(--nord8);
    font: 12px/1 var(--mono);
  }

  .fold[open] > summary::after { content: "-"; }

  .fold-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fold-count {
    color: var(--nord10);
    font-size: 10px;
    font-weight: 800;
  }

  .fold-body { padding: 0 8px 8px; }

  .file-list { display: grid; gap: 5px; margin-bottom: 10px; }

  .file-row {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 7px 9px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: rgba(10, 13, 18, 0.86);
    transition: transform 130ms ease, border-color 130ms ease, background 130ms ease;
  }

  .file-row:hover,
  .hit:hover {
    transform: translateX(2px);
    border-color: var(--line-strong);
    background: rgba(15, 19, 26, 0.96);
  }

  .file-code {
    color: var(--nord8);
    font: 10px/1.2 var(--mono);
    font-weight: 800;
  }

  .file-name {
    overflow: hidden;
    color: var(--nord6);
    font-family: var(--mono);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-tag {
    color: var(--nord10);
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .empty {
    padding: 10px;
    border: 1px dashed var(--line-strong);
    border-radius: 8px;
    background: var(--nord0);
    color: var(--nord5);
    font-size: 11px;
  }

  .search { display: grid; gap: 4px; }

  .hit {
    display: grid;
    grid-template-columns: minmax(120px, 0.36fr) minmax(0, 1fr);
    gap: 8px;
    padding: 7px 8px;
    border-radius: 8px;
    border: 1px solid transparent;
    transition: transform 130ms ease, border-color 130ms ease, background 130ms ease;
  }

  .hit:nth-child(odd) { background: var(--nord2); }

  .hit-file {
    overflow: hidden;
    color: var(--nord9);
    font-weight: 800;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hit-text { color: var(--nord6); overflow-wrap: anywhere; }

  .footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: space-between;
    padding: 8px 12px;
    border-top: 1px solid var(--line);
    background: var(--nord0);
    color: var(--nord10);
    font-size: 10px;
    font-weight: 650;
  }

  .footer code {
    color: var(--nord8);
    font-family: var(--mono);
    font-size: 10px;
  }

  .skill-bars {
    display: grid;
    gap: 6px;
    margin-bottom: 10px;
  }

  .skill-bar {
    display: grid;
    grid-template-columns: 56px 1fr 28px;
    gap: 8px;
    align-items: center;
    font-size: 10px;
    color: var(--nord5);
  }

  .skill-track {
    height: 6px;
    border-radius: 999px;
    background: var(--nord3);
    overflow: hidden;
  }

  .skill-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--nord11);
  }

  .muted { color: var(--nord5); }

  .skeleton {
    display: grid;
    gap: 7px;
    padding: 12px 14px 14px 18px;
  }

  .skeleton span {
    height: 8px;
    max-width: 78%;
    border-radius: 999px;
    background: var(--nord3);
    animation: least-sheen 1.55s ease-in-out infinite;
  }

  .skeleton span:nth-child(2) { max-width: 52%; animation-delay: 0.12s; }
  .skeleton span:nth-child(3) { max-width: 66%; animation-delay: 0.24s; }

  @keyframes least-sheen {
    0%, 100% { opacity: 0.42; transform: translateX(0); }
    50% { opacity: 1; transform: translateX(2px); }
  }

  @keyframes least-card-in {
    from { opacity: 0; transform: translateY(6px) scale(0.992); filter: saturate(0.8); }
    to { opacity: 1; transform: translateY(0) scale(1); filter: saturate(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .card,
    .skeleton span,
    .metric,
    .summary-item,
    .file-row,
    .hit {
      animation: none;
      transition: none;
    }
  }

  @media (max-width: 720px) {
    .head { grid-template-columns: 30px minmax(0, 1fr); }
    .meta { grid-column: 1 / -1; justify-content: flex-start; }
    .summary, .metrics, .hit, .file-row { grid-template-columns: 1fr; }
    .summary, .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>

<script>
  const root = document.getElementById("root");

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function truncate(value, max = 9000) {
    const text = String(value ?? "");
    return text.length > max ? text.slice(0, max) + "\n...[truncated in widget]" : text;
  }

  function countLines(value) {
    const text = String(value || "");
    if (!text) return 0;
    return text.replace(/\n$/, "").split("\n").length;
  }

  function previewLines(value, maxLines = 18) {
    const text = String(value || "").replace(/\n$/, "");
    if (!text) return "";
    const lines = text.split("\n");
    const shown = lines.slice(0, maxLines).join("\n");
    const remaining = lines.length - maxLines;
    return remaining > 0 ? shown + "\n...[" + remaining + " more lines]" : shown;
  }

  function basename(value) {
    const text = String(value || "");
    return text.split("/").filter(Boolean).pop() || text || ".";
  }

  function shortId(value) {
    const text = String(value || "");
    if (!text) return "-";
    return text.length > 14 ? text.slice(0, 8) + "..." + text.slice(-4) : text;
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return "-";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  function parseGitBranch(status) {
    const line = String(status || "").split("\n").find((row) => row.startsWith("##"));
    if (!line) return "";
    const body = line.slice(2).trim();
    const branch = body.split("...")[0].trim();
    return branch || body;
  }

  function titleFor(tool) {
    const titles = {
      open_current_workspace: "Workspace",
      open_workspace: "Workspace",
      write: "File write",
      edit: "Exact edit",
      git_diff: "Git diff",
      show_changes: "Change review",
      export_pro_context: "Pro context",
      handoff_to_agent: "Agent handoff",
      handoff_to_codex: "Codex handoff",
      bash: "Terminal",
      shell: "Terminal",
      files: "Files",
      search: "Search",
      read: "Read file",
      context_pack: "Context pack",
      least_gain: "Least gain",
      least_discover: "Least discover",
      retrieve_output: "Retrieve output"
    };
    return titles[tool] || (tool ? tool.replace(/_/g, " ") : "Least");
  }

  function iconFor(tool) {
    const icons = {
      open_current_workspace: "W",
      open_workspace: "W",
      write: "W",
      edit: "E",
      git_diff: "G",
      show_changes: "D",
      export_pro_context: "P",
      handoff_to_agent: "A",
      handoff_to_codex: "C",
      bash: "$",
      shell: "$",
      files: "F",
      agent_list: "A",
      agent_doctor: "A",
      agent_terminal_doctor: "T",
      agent_sessions: "S",
      agent_attach_hint: "A",
      agent_plan: "P",
      agent_start: "A",
      agent_status: "S",
      agent_watchdog: "W",
      agent_tail: "T",
      agent_result: "R",
      agent_cancel: "!",
      agent_resume: "R",
      agent_cleanup: "C",
      search: "S",
      read: "R",
      context_pack: "K"
    };
    return icons[tool] || "L";
  }

  function subtitleFor(data) {
    if (data?.least_tool === "open_current_workspace" || data?.least_tool === "open_workspace") {
      const branch = parseGitBranch(data?.git_status);
      return branch ? branch + " · " + basename(data?.root || "") : (data?.root || "Workspace opened");
    }
    if (data?.least_tool === "show_changes") {
      if (data?.status_error || data?.diff_error) return "Git state unavailable";
      const count = Array.isArray(data?.changed_files) ? data.changed_files.length : 0;
      const untracked = Number(data?.untracked_summary?.count || 0);
      if (!count && !untracked && !data?.changed) return "Working tree clean";
      const parts = [];
      if (count) parts.push(count + " tracked");
      if (untracked) parts.push(untracked + " untracked");
      return parts.join(" · ");
    }
    if (data?.least_tool === "handoff_to_agent" || data?.least_tool === "handoff_to_codex") {
      return data?.agent_name || data?.agent || "Handoff written";
    }
    if (data?.least_tool === "files") {
      const count = Number(data?.count ?? (Array.isArray(data?.files) ? data.files.length : 0));
      return count + " files · " + (data?.path || data?.root || "workspace");
    }
    if (String(data?.least_tool || "").startsWith("agent_")) {
      const state = data?.state || data?.ok || data?.conclusion || "agent";
      return [state, data?.agent, data?.job_id || data?.task_id].filter(Boolean).join(" · ");
    }
    if (data?.path) return data.path;
    if (data?.plan_path) return data.plan_path;
    if (data?.root) return data.root;
    if (data?.cwd) return data.cwd;
    return "Tool output";
  }

  function pill(text, cls) {
    if (!text) return "";
    return '<span class="pill ' + esc(cls || "") + '">' + esc(text) + '</span>';
  }

  function header(data, pills) {
    const tool = data?.least_tool;
    return [
      '<div class="rail"></div>',
      '<header class="head">',
      '<span class="glyph">' + esc(iconFor(tool)) + '</span>',
      '<div class="headline"><div class="title">' + esc(titleFor(tool)) + '</div><div class="subtitle">' + esc(subtitleFor(data)) + '</div></div>',
      '<div class="meta">' + (pills || "") + '</div>',
      '</header>'
    ].join("");
  }

  function footer(data) {
    const id = data?.workspace_id ? '<code>' + esc(shortId(data.workspace_id)) + '</code>' : "";
    const tool = data?.least_tool ? "tool " + esc(data.least_tool) : "least";
    return '<footer class="footer"><span>' + tool + '</span><span>workspace ' + (id || "-") + '</span></footer>';
  }

  function stripItem(key, value) {
    if (!value) return "";
    return '<span class="strip-item"><span class="strip-key">' + esc(key) + '</span><span>' + esc(value) + '</span></span>';
  }

  function statusStrip(data) {
    const branch = parseGitBranch(data?.git_status);
    const lock = data?.lock;
    const lockText = lock?.locked ? "locked" : data?.concurrency_mode && data.concurrency_mode !== "off" ? "unlocked" : "";
    const items = [
      stripItem("branch", branch),
      stripItem("toolset", data?.toolset),
      stripItem("shell", data?.shell_backend),
      stripItem("lock", lockText),
      stripItem("concurrency", data?.concurrency_mode)
    ].filter(Boolean).join("");
    return items ? '<div class="strip">' + items + '</div>' : "";
  }

  function compactionBanner(data) {
    if (!data?.compacted && !data?.output_meta?.compacted) return "";
    const raw = formatBytes(data?.rawBytes ?? data?.output_meta?.rawBytes);
    const visible = formatBytes(data?.visibleBytes ?? data?.output_meta?.visibleBytes);
    const saved = formatBytes(data?.savedBytes ?? data?.output_meta?.savedBytes);
    const key = data?.output_meta?.retrievalKey || data?.output_meta?.retrievalHint || "";
    const hint = key ? '<div class="muted">Retrieve omitted detail with <strong>retrieve_output</strong>.</div>' : "";
    return '<div class="banner"><div><strong>Compact output</strong> · raw ' + esc(raw) + ' → visible ' + esc(visible) + (saved !== "-" ? ' · saved ' + esc(saved) : '') + '</div>' + hint + '</div>';
  }

  function metric(label, value, small) {
    return '<div class="metric"><span class="label">' + esc(label) + '</span><div class="value' + (small ? " small" : "") + '">' + esc(value ?? "-") + '</div></div>';
  }

  function summaryItem(label, value) {
    return '<div class="summary-item"><span class="summary-label">' + esc(label) + '</span><div class="summary-value">' + esc(value ?? "-") + '</div></div>';
  }

  function codebox(label, text, extraClass) {
    return '<div class="code ' + esc(extraClass || "") + '"><div class="codebar"><span>' + esc(label || "output") + '</span></div><pre>' + text + '</pre></div>';
  }

  function fold(title, count, body, open) {
    if (!body) return "";
    return '<details class="fold"' + (open ? " open" : "") + '><summary><span class="fold-title">' + esc(title) + '</span><span class="fold-count">' + esc(count || "") + '</span></summary><div class="fold-body">' + body + '</div></details>';
  }

  function shortSource(value) {
    if (value === "workspace") return "repo";
    if (value === "plugin") return "plug";
    if (value === "user") return "user";
    return "skill";
  }

  function skillBars(counts) {
    const total = Math.max(1, Number(counts?.total || 0));
    const rows = [
      ["repo", Number(counts?.workspace || 0)],
      ["user", Number(counts?.user || 0)],
      ["plug", Number(counts?.plugin || 0)]
    ].filter((row) => row[1] > 0);
    if (!rows.length) return "";
    return '<div class="skill-bars">' + rows.map(([label, count]) => {
      const pct = Math.max(8, Math.round((count / total) * 100));
      return '<div class="skill-bar"><span>' + esc(label) + '</span><div class="skill-track"><div class="skill-fill" style="width:' + pct + '%"></div></div><span>' + esc(count) + '</span></div>';
    }).join("") + '</div>';
  }

  function renderDiff(diff) {
    return truncate(diff, 14000).split("\n").map((line) => {
      let cls = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) cls += " diff-add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls += " diff-del";
      else if (line.startsWith("@@")) cls += " diff-hunk";
      return '<span class="' + cls + '">' + esc(line) + '</span>';
    }).join("");
  }

  function renderFile(data) {
    const pills = [
      pill(data.path ? basename(data.path) : "", "accent"),
      data.bytes !== undefined ? pill(formatBytes(data.bytes), "muted") : "",
      data.sha256 ? pill(shortId(data.sha256), "muted") : "",
      data.additions !== undefined ? pill("+" + data.additions, "good") : "",
      data.deletions !== undefined ? pill("-" + data.deletions, "bad") : ""
    ].join("");
    const body = data.diff ? renderDiff(data.diff) : esc(truncate(data.text || ""));
    return '<article class="card">' + header(data, pills) + compactionBanner(data) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Bytes", formatBytes(data.bytes)) +
      summaryItem("Added", "+" + (data.additions ?? 0)) +
      summaryItem("Removed", "-" + (data.deletions ?? 0)) +
      summaryItem("Edits", data.replacements ?? "-") +
      '</div>' +
      codebox(basename(data.path || data.plan_path || "file"), body, "") +
      '</div>' + footer(data) + '</article>';
  }

  function renderChanges(data) {
    const files = Array.isArray(data.changed_files) ? data.changed_files : [];
    const untracked = data.untracked_summary;
    const hasGitError = Boolean(data.status_error || data.diff_error);
    const changed = Boolean(data.changed);
    const pills = [
      hasGitError ? pill("git unavailable", "warn") : changed ? pill("dirty", "warn") : pill("clean", "good"),
      data.staged ? pill("staged", "frost") : "",
      data.summary_only ? pill("summary only", "muted") : pill(data.include_diff === false ? "no diff" : "with diff", "frost"),
      data.additions !== undefined ? pill("+" + data.additions, "good") : "",
      data.deletions !== undefined ? pill("-" + data.deletions, "bad") : ""
    ].join("");
    const fileRows = files.slice(0, 12).map((line) => {
      const status = String(line).slice(0, 2).trim() || "?";
      const name = String(line).slice(2).trim() || String(line);
      return '<div class="file-row"><span class="file-code">' + esc(status) + '</span><span class="file-name">' + esc(name) + '</span><span class="file-tag">tracked</span></div>';
    }).join("");
    const moreFiles = files.length > 12 ? '<div class="empty">+' + esc(files.length - 12) + ' more changed files</div>' : "";
    const untrackedRows = Array.isArray(untracked?.paths) ? untracked.paths.slice(0, 8).map((item) => {
      const path = typeof item === "string" ? item : item?.path || "?";
      const kind = typeof item === "object" && item?.kind ? item.kind : "file";
      return '<div class="file-row"><span class="file-code">??</span><span class="file-name">' + esc(path) + '</span><span class="file-tag">' + esc(kind) + '</span></div>';
    }).join("") : "";
    const state = hasGitError
      ? '<div class="empty">' + esc(data.status_error || data.diff_error) + '</div>'
      : fileRows
        ? '<div class="file-list">' + fileRows + '</div>' + moreFiles
        : '<div class="empty">No tracked changes.</div>';
    const untrackedBlock = untracked?.count
      ? '<div class="section-label">Untracked</div><div class="file-list">' + (untrackedRows || '<div class="empty">' + esc(untracked.text || (untracked.count + " files")) + '</div>') + '</div>'
      : "";
    const diff = data.diff ? codebox("diff", renderDiff(data.diff), "") : "";
    return '<article class="card">' + header(data, pills) + statusStrip({ git_status: data.status }) + compactionBanner(data) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Tracked", files.length) +
      summaryItem("Untracked", untracked?.count ?? 0) +
      summaryItem("Added", "+" + (data.additions ?? 0)) +
      summaryItem("Deleted", "-" + (data.deletions ?? 0)) +
      '</div>' +
      '<div class="section-label">Tracked changes</div>' + state +
      untrackedBlock +
      diff +
      '</div>' + footer(data) + '</article>';
  }

  function gitStatusRows(status, max = 10) {
    return String(status || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("##"))
      .slice(0, max)
      .map((line) => {
        const code = line.slice(0, 2).trim() || "?";
        const name = line.slice(2).trim() || line;
        return '<div class="file-row"><span class="file-code">' + esc(code) + '</span><span class="file-name">' + esc(name) + '</span><span class="file-tag">git</span></div>';
      })
      .join("");
  }

  function renderWorkspace(data) {
    const skills = Array.isArray(data.skill_inventory) ? data.skill_inventory : (Array.isArray(data.skills) ? data.skills.map((name) => ({ name, source: "workspace" })) : []);
    const skillCount = Number(data.skill_counts?.total ?? skills.length);
    const changedRows = gitStatusRows(data.git_status, 10);
    const gitLines = String(data.git_status || "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("##"));
    const branch = parseGitBranch(data.git_status);
    const pills = [
      pill(branch || "no branch", "frost"),
      pill(data.agents_loaded ? (data.agents_path || "AGENTS.md") : "no AGENTS", data.agents_loaded ? "good" : "warn"),
      pill(skillCount + " skills", skillCount ? "accent" : "muted"),
      pill("tools " + (data.tool_mode || "-"), "muted")
    ].join("");
    const contextRows = [
      '<div class="file-row"><span class="file-code">root</span><span class="file-name">' + esc(data.root || ".") + '</span><span class="file-tag">path</span></div>',
      data.workspace_id ? '<div class="file-row"><span class="file-code">id</span><span class="file-name">' + esc(data.workspace_id) + '</span><span class="file-tag">session</span></div>' : "",
      data.agents_loaded ? '<div class="file-row"><span class="file-code">rules</span><span class="file-name">' + esc(data.agents_path || "AGENTS.md") + '</span><span class="file-tag">agent</span></div>' : "",
      data.toolset ? '<div class="file-row"><span class="file-code">set</span><span class="file-name">' + esc(data.toolset) + '</span><span class="file-tag">tools</span></div>' : ""
    ].join("");
    const skillRows = skills.slice(0, 18).map((skill) => {
      const value = typeof skill === "string" ? skill : (skill?.name || "skill");
      const source = typeof skill === "string" ? "skill" : shortSource(skill?.source);
      const desc = typeof skill === "object" && skill?.description ? skill.description : "";
      return '<div class="file-row"><span class="file-code">' + esc(source) + '</span><span class="file-name" title="' + esc(desc) + '">' + esc(value) + '</span><span class="file-tag">skill</span></div>';
    }).join("");
    const skillText = skills.length
      ? skillBars(data.skill_counts) + '<div class="file-list">' + skillRows + '</div>' + (skills.length > 18 ? '<div class="empty">+' + esc(skills.length - 18) + ' more skills</div>' : "")
      : '<div class="empty">No skills discovered. Pass include_skills=true or include_global_skills=true.</div>';
    const gitText = changedRows
      ? '<div class="file-list">' + changedRows + '</div>' + (gitLines.length > 10 ? '<div class="empty">+' + esc(gitLines.length - 10) + ' more changed paths</div>' : "")
      : '<div class="empty">Working tree clean.</div>';
    const tree = data.tree ? codebox("tree", esc(previewLines(data.tree, 20)), "") : "";
    const lock = data.lock;
    const lockNote = lock?.locked
      ? '<div class="banner"><strong>Workspace lock active</strong> · owner ' + esc(lock.owner_label || lock.owner_session_id || "unknown") + (lock.seconds_remaining !== undefined ? ' · ' + esc(lock.seconds_remaining) + 's left' : '') + '</div>'
      : "";
    return '<article class="card">' + header(data, pills) + statusStrip(data) + '<div class="body">' + lockNote +
      '<div class="summary">' +
      summaryItem("Write", data.write_mode || "-") +
      summaryItem("Bash", data.bash_mode || "-") +
      summaryItem("Tools", data.tool_mode || "-") +
      summaryItem("Skills", skillCount) +
      '</div>' +
      '<div class="section-label">Workspace</div><div class="file-list">' + contextRows + '</div>' +
      fold("Git", gitLines.length ? gitLines.length + " paths" : "clean", gitText, gitLines.length > 0) +
      fold("Skills", skillCount + " discovered", skillText, skillCount > 0) +
      fold("Tree", data.tree ? "available" : "", tree, false) +
      '</div>' + footer(data) + '</article>';
  }

  function renderHandoff(data) {
    const pills = [
      pill(data.agent_name || data.agent || "agent", "accent"),
      data.model ? pill(data.model, "frost") : "",
      data.additions !== undefined ? pill("+" + data.additions, "good") : "",
      data.deletions !== undefined ? pill("-" + data.deletions, "bad") : ""
    ].join("");
    const rows = [
      data.plan_path ? '<div class="file-row"><span class="file-code">plan</span><span class="file-name">' + esc(data.plan_path) + '</span><span class="file-tag">md</span></div>' : "",
      data.status_path ? '<div class="file-row"><span class="file-code">status</span><span class="file-name">' + esc(data.status_path) + '</span><span class="file-tag">md</span></div>' : "",
      data.diff_path ? '<div class="file-row"><span class="file-code">diff</span><span class="file-name">' + esc(data.diff_path) + '</span><span class="file-tag">patch</span></div>' : "",
      data.execution_log_path ? '<div class="file-row"><span class="file-code">log</span><span class="file-name">' + esc(data.execution_log_path) + '</span><span class="file-tag">jsonl</span></div>' : ""
    ].join("");
    const diff = data.diff ? codebox("plan diff", renderDiff(data.diff), "") : "";
    return '<article class="card state-' + esc(stateClass) + '">' + header(data, pills) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Agent", data.agent_name || data.agent || "-") +
      summaryItem("Model", data.model || "-") +
      summaryItem("Added", "+" + (data.additions ?? 0)) +
      summaryItem("Removed", "-" + (data.deletions ?? 0)) +
      '</div>' +
      '<div class="section-label">Handoff files</div><div class="file-list">' + rows + '</div>' +
      diff +
      '</div>' + footer(data) + '</article>';
  }

  function renderBash(data) {
    const ok = Number(data.exitCode) === 0;
    const stdoutLines = countLines(data.stdout);
    const stderrLines = countLines(data.stderr);
    const totalLines = stdoutLines + stderrLines;
    const pills = [
      pill(ok ? "passed" : "failed", ok ? "good" : "bad"),
      data.timedOut || data.truncated ? pill("truncated", "warn") : "",
      pill(totalLines + " lines", "frost"),
      pill((data.durationMs ?? "-") + " ms", "muted")
    ].join("");
    const command = '<span class="prompt">$</span> ' + esc(data.command || "");
    const output = previewLines(data.stdout || data.stderr || "", 20);
    const outputBox = output ? codebox("output preview", esc(truncate(output, 5000)), "terminal") : '<div class="empty">Command produced no output.</div>';
    return '<article class="card">' + header(data, pills) + compactionBanner(data) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Exit", data.exitCode ?? "-") +
      summaryItem("Signal", data.signal || "-") +
      summaryItem("Lines", totalLines) +
      summaryItem("Duration", (data.durationMs ?? "-") + " ms") +
      '</div>' +
      codebox("command", command, "terminal") +
      outputBox +
      '</div>' + footer(data) + '</article>';
  }

  function renderFiles(data) {
    const files = Array.isArray(data.files) ? data.files : [];
    const count = Number(data.count ?? files.length);
    const extCounts = new Map();
    for (const file of files) {
      const base = String(file).split("/").pop() || String(file);
      const dot = base.lastIndexOf(".");
      const ext = dot > 0 ? base.slice(dot).toLowerCase() : "[no-ext]";
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    }
    const topExts = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, 6)
      .map(([ext, n]) => ext + " " + n)
      .join(" · ");
    const rows = files.slice(0, 60).map((file) => {
      const text = String(file);
      const slash = text.lastIndexOf("/");
      const dir = slash >= 0 ? text.slice(0, slash) || "." : ".";
      return '<div class="file-row"><span class="file-code">file</span><span class="file-name">' + esc(text) + '</span><span class="file-tag">' + esc(dir === "." ? "root" : basename(dir)) + '</span></div>';
    }).join("");
    const more = count > 60 ? '<div class="empty">+' + esc(count - 60) + ' more files omitted from the card.</div>' : "";
    const body = rows ? '<div class="file-list">' + rows + '</div>' + more : '<div class="empty">No files matched.</div>';
    const pills = [
      pill(count + " files", "frost"),
      pill(data.backend || data.used || "files", "muted"),
      data.truncated ? pill("truncated", "warn") : "",
      data.cacheHit ? pill("cache", "accent") : ""
    ].join("");
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Files", count) +
      summaryItem("Shown", files.length) +
      summaryItem("Backend", data.backend || data.used || "-") +
      summaryItem("Extensions", topExts || "-") +
      '</div>' + body + '</div>' + footer(data) + '</article>';
  }

  function renderAgent(data) {
    const state = data.state || data.conclusion || (data.ok === true ? "ok" : data.ok === false ? "not ok" : "ready");
    const badStates = ["failed", "failed-to-launch", "cancelled", "orphaned", "not ok"];
    const warnStates = ["accepted", "provisioning", "running", "recovery-required", "still-running"];
    const stateClass = badStates.includes(String(state)) ? "bad" : warnStates.includes(String(state)) ? "warn" : "good";
    const pills = [
      pill(state, stateClass),
      data.agent ? pill(data.agent, "accent") : "",
      data.repository ? pill(data.repository, "muted") : "",
      data.source ? pill(data.source, "frost") : ""
    ].join("");
    const rows = [
      data.job_id ? '<div class="file-row"><span class="file-code">job</span><span class="file-name">' + esc(data.job_id) + '</span><span class="file-tag">id</span></div>' : "",
      data.task_id ? '<div class="file-row"><span class="file-code">task</span><span class="file-name">' + esc(data.task_id) + '</span><span class="file-tag">id</span></div>' : "",
      data.worktree_dir ? '<div class="file-row"><span class="file-code">tree</span><span class="file-name">' + esc(data.worktree_dir) + '</span><span class="file-tag">path</span></div>' : "",
      data.session_name ? '<div class="file-row"><span class="file-code">term</span><span class="file-name">' + esc(data.session_name) + '</span><span class="file-tag">session</span></div>' : "",
      data.result_path ? '<div class="file-row"><span class="file-code">out</span><span class="file-name">' + esc(data.result_path) + '</span><span class="file-tag">result</span></div>' : ""
    ].join("");
    const commands = [];
    for (const key of ["attach_commands", "watch_commands", "tail_commands", "fallback_commands"]) {
      if (Array.isArray(data[key])) commands.push(...data[key].map((item) => typeof item === "string" ? item : item?.command || JSON.stringify(item)));
    }
    const commandBox = commands.length ? codebox("attach / watch commands", esc(commands.slice(0, 8).join("\n")), "terminal") : "";
    const tailText = data.tail && typeof data.tail === "object" ? (data.tail.text || data.tail.output || "") : (data.output || data.text || "");
    const tailBox = tailText ? codebox("agent output preview", esc(previewLines(tailText, 24)), "terminal") : "";
    const jsonBox = fold("Structured details", "json", codebox("structured output", esc(truncate(JSON.stringify(data || {}, null, 2), 9000)), ""), false);
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("State", state) +
      summaryItem("Agent", data.agent || "-") +
      summaryItem("Job", data.job_id ? shortId(data.job_id) : "-") +
      summaryItem("Task", data.task_id ? shortId(data.task_id) : "-") +
      '</div>' +
      (rows ? '<div class="section-label">Agent job</div><div class="file-list">' + rows + '</div>' : "") +
      commandBox + tailBox + jsonBox +
      '</div>' + footer(data) + '</article>';
  }

  function renderSearch(data) {
    const count = Array.isArray(data.matches) ? data.matches.length : 0;
    const lines = String(data.text || "").split("\\n").filter(Boolean).slice(0, 90);
    const hits = lines.map((line) => {
      const parts = line.split(":");
      const file = parts.length > 2 ? parts.slice(0, 2).join(":") : (parts[0] || "match");
      const body = parts.length > 2 ? parts.slice(2).join(":").trim() : line;
      return '<div class="hit"><div class="hit-file">' + esc(file) + '</div><div class="hit-text">' + esc(body) + '</div></div>';
    }).join("") || '<div class="muted">No matches.</div>';
    return '<article class="card">' + header(data, pill(count + " matches", "frost") + pill(data.used || data.backend || "search", "muted")) +
      compactionBanner(data) +
      '<div class="body"><div class="search">' + hits + '</div></div>' + footer(data) + '</article>';
  }

  function renderGeneric(data) {
    const keys = Object.keys(data || {}).filter((key) => !key.startsWith("least_") && key !== "text");
    const priority = ["profile", "task", "query", "changed", "count", "matches", "records", "findings", "recommendations", "raw_bytes_processed", "visible_bytes_emitted"];
    const ordered = [...priority.filter((key) => keys.includes(key)), ...keys.filter((key) => !priority.includes(key))];
    const metrics = ordered.slice(0, 6).map((key) => {
      const value = data[key];
      const rendered = typeof value === "object" ? JSON.stringify(value) : value;
      return metric(key.replace(/_/g, " "), rendered, String(rendered || "").length > 18);
    }).join("");
    return '<article class="card">' + header(data, pill("structured", "frost")) + compactionBanner(data) + '<div class="body">' +
      (metrics ? '<div class="metrics">' + metrics + '</div>' : "") +
      codebox("structured output", esc(truncate(JSON.stringify(data || {}, null, 2))), "") +
      '</div>' + footer(data) + '</article>';
  }

  function isPlaceholderPayload(data) {
    if (!data || typeof data !== "object") return true;
    const keys = Object.keys(data);
    return !keys.length || (keys.length === 1 && data.least_tool === "least");
  }

  function renderPending() {
    if (!root) return;
    root.innerHTML = [
      '<article class="card pending">',
      '<div class="rail"></div>',
      '<header class="head">',
      '<span class="glyph">L</span>',
      '<div class="headline"><div class="title">Least</div><div class="subtitle">Waiting for tool result...</div></div>',
      '<span class="pill frost">waiting</span>',
      '</header>',
      '<div class="skeleton"><span></span><span></span><span></span></div>',
      '</article>'
    ].join("");
  }

  function render(data) {
    if (!root) return;
    if (isPlaceholderPayload(data)) {
      renderPending();
      return;
    }
    const tool = data.least_tool;
    if (tool === "open_current_workspace" || tool === "open_workspace") {
      root.innerHTML = renderWorkspace(data);
    } else if (tool === "show_changes") {
      root.innerHTML = renderChanges(data);
    } else if (tool === "handoff_to_agent" || tool === "handoff_to_codex") {
      root.innerHTML = renderHandoff(data);
    } else if (tool === "write" || tool === "edit" || tool === "git_diff" || tool === "export_pro_context" || tool === "read") {
      root.innerHTML = renderFile(data);
    } else if (tool === "files") {
      root.innerHTML = renderFiles(data);
    } else if (tool === "bash" || tool === "shell") {
      root.innerHTML = renderBash(data);
    } else if (String(tool || "").startsWith("agent_")) {
      root.innerHTML = renderAgent(data);
    } else if (tool === "search" || tool === "search_context") {
      root.innerHTML = renderSearch(data);
    } else {
      root.innerHTML = renderGeneric(data);
    }
  }

  function safeRender(data) {
    try {
      render(data);
    } catch (error) {
      if (!root) return;
      root.innerHTML = [
        '<article class="card">',
        '<div class="rail"></div>',
        '<header class="head">',
        '<span class="glyph">!</span>',
        '<div class="headline"><div class="title">Least widget error</div><div class="subtitle">',
        esc(error && error.message ? error.message : String(error)),
        '</div></div>',
        '<span class="pill bad">error</span>',
        '</header>',
        '<div class="body"><div class="empty">Retry the tool or refresh MCP app actions.</div></div>',
        '</article>'
      ].join("");
    }
  }

  safeRender(window.openai && window.openai.toolOutput ? window.openai.toolOutput : (window.openai && window.openai.toolResponseMetadata ? window.openai.toolResponseMetadata : {}));

  window.addEventListener("openai:set_globals", (event) => {
    const globals = event.detail && event.detail.globals ? event.detail.globals : {};
    safeRender(globals.toolOutput || (window.openai && window.openai.toolOutput ? window.openai.toolOutput : {}));
  }, { passive: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      const params = message.params && typeof message.params === "object" ? message.params : {};
      safeRender(params.structuredContent || {});
    }
  }, { passive: true });
</script>
`.trim();
