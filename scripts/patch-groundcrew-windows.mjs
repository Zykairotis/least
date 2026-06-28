#!/usr/bin/env node

// Groundcrew 4.x Windows compatibility patches for Least local agent runs.
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "node_modules", "@clipboard-health", "groundcrew", "dist", "lib");

function patchFile(relativePath, apply) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) {
    console.log(`patch-groundcrew-windows: skip missing ${relativePath}`);
    return false;
  }
  const before = fs.readFileSync(target, "utf8");
  const after = apply(before);
  if (after === before) return false;
  fs.writeFileSync(target, after, "utf8");
  console.log(`patch-groundcrew-windows: patched ${relativePath}`);
  return true;
}

let patched = 0;

if (
  patchFile("adapters/registry.js", (source) => {
    if (source.includes("pathToFileURL(modulePath).href")) return source;
    if (!source.includes('from "node:url"')) {
      source = source.replace(
        'import path from "node:path";',
        'import path from "node:path";\nimport { pathToFileURL } from "node:url";'
      );
    }
    return source.replace(
      "const mod = await import(__rewriteRelativeImportExtension(modulePath));",
      "const mod = await import(__rewriteRelativeImportExtension(pathToFileURL(modulePath).href));"
    );
  })
) {
  patched += 1;
}

if (
  patchFile("host.js", (source) => {
    if (source.includes('runCommandAsync("where", [cmd])')) return source;
    return source.replace(
      `export async function which(cmd, signal) {
    try {
        const out = signal === undefined
            ? await runCommandAsync("which", [cmd])
            : await runCommandAsync("which", [cmd], { signal });
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }`,
      `export async function which(cmd, signal) {
    try {
        if (process.platform === "win32") {
            const out = signal === undefined
                ? await runCommandAsync("where", [cmd])
                : await runCommandAsync("where", [cmd], { signal });
            const first = out
                .trim()
                .split(/\\r?\\n/)
                .map((line) => line.trim())
                .find((line) => line.length > 0);
            return first;
        }
        const out = signal === undefined
            ? await runCommandAsync("which", [cmd])
            : await runCommandAsync("which", [cmd], { signal });
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }`
    );
  })
) {
  patched += 1;
}

if (
  patchFile("zellijAdapter.js", (source) => {
    if (source.includes("function stageWindowsPaneCommand(")) return source;
    source = source.replace(
      `function shSingleQuote(value) {
    return '\${value.replaceAll("'", String.raw \`'\\\\''\`)}';
}
`,
      `function shSingleQuote(value) {
    return '\${value.replaceAll("'", String.raw \`'\\\\''\`)}';
}
function windowsLauncherBase(ticket) {
    const safeTicket = ticket.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(staging(), \`tab-\${safeTicket}-win-launch\`);
}
function stageWindowsPaneCommand(ticket, wrapped) {
    const shLaunch = path.resolve(process.cwd(), "scripts", "groundcrew-bin", "sh-launch.ps1");
    if (!existsSync(shLaunch)) {
        return undefined;
    }
    const base = windowsLauncherBase(ticket);
    const ps1Path = \`\${base}.ps1\`;
    const cmdPath = \`\${base}.cmd\`;
    const ps1Body = [
        '$ErrorActionPreference = "Stop"',
        \`& "\${shLaunch.replaceAll('"', '""')}" -c @'\`,
        wrapped,
        "'@",
        "exit $LASTEXITCODE",
        "",
    ].join("\\r\\n");
    const cmdBody = [
        "@echo off",
        \`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\${ps1Path}"\`,
        "exit /b %ERRORLEVEL%",
        "",
    ].join("\\r\\n");
    writeFileSync(ps1Path, ps1Body);
    writeFileSync(cmdPath, cmdBody);
    return cmdPath;
}
`
    );
    source = source.replace(
      /    const wrapped = `trap \$\{shSingleQuote\(`touch \$\{exitMarkerPath\(ticket\)\}`\)\} EXIT; \$\{command\}`;[\s\S]*?    const paneArgs =[\s\S]*?;/,
      `    const wrapped = \`trap \${shSingleQuote(\`touch \${exitMarkerPath(ticket)}\`)} EXIT; \${command}\`;
    const windowsPaneCommand = process.platform === "win32" ? stageWindowsPaneCommand(ticket, wrapped) : undefined;
    const paneCommand = windowsPaneCommand ?? "sh";
    const paneArgs = windowsPaneCommand !== undefined ? "" : \`        args "-c" "\${kdlString(wrapped)}"\`;`
    );
    source = source.replace('    pane command="${paneCommand}" {', '    pane command="${kdlString(paneCommand)}" {');
    return source;
  })
) {
  patched += 1;
}

if (patched === 0) {
  console.log("patch-groundcrew-windows: already patched");
} else {
  console.log(`patch-groundcrew-windows: applied ${patched} patch(es)`);
}
