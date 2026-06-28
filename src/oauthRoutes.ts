import { createHash, randomUUID } from "node:crypto";
import type express from "express";
import type { LeastConfig } from "./config.js";

const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_SECONDS = 31_536_000;

type PendingCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  createdAt: number;
};

const pendingCodes = new Map<string, PendingCode>();

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cleanupPendingCodes(now = Date.now()): void {
  for (const [code, pending] of pendingCodes) {
    if (now - pending.createdAt > CODE_TTL_MS) pendingCodes.delete(code);
  }
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function invalidRequest(res: express.Response): void {
  res.status(400).json({ error: "invalid_request" });
}

function invalidGrant(res: express.Response): void {
  res.status(400).json({ error: "invalid_grant" });
}

function debugOAuthGrant(reason: string, details: Record<string, unknown> = {}): void {
  if (process.env.LEAST_DEBUG_OAUTH !== "1") return;
  console.error(`[LeastOAuth] invalid_grant ${reason}`, JSON.stringify(details));
}

type OAuthRequestShape = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  state?: string;
};

function requestOrigin(req: express.Request): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || `${req.hostname}`;
  return `${proto}://${host}`;
}

function parseAuthorizationRequest(
  source: Record<string, unknown>,
  config: LeastConfig
): OAuthRequestShape | { error: true } {
  const responseType = readString(source, "response_type");
  const clientId = readString(source, "client_id");
  const redirectUri = readString(source, "redirect_uri");
  const codeChallenge = readString(source, "code_challenge");
  const codeChallengeMethod = readString(source, "code_challenge_method");
  const state = readString(source, "state");
  const resource = readString(source, "resource");
  const requestedScope = readString(source, "scope")?.trim() ?? "";
  const scope = requestedScope.length === 0 ? "" : requestedScope;

  if (responseType !== "code") return { error: true };
  if (clientId !== config.grokOAuthClientId) return { error: true };
  if (!redirectUri) return { error: true };
  if (!codeChallenge) return { error: true };
  if (codeChallengeMethod !== "S256") return { error: true };
  if (scope && scope !== "mcp") return { error: true };

  return {
    clientId,
    redirectUri,
    codeChallenge,
    scope,
    resource,
    state
  };
}

function authorizationPage(config: LeastConfig, request: OAuthRequestShape): string {
  const requestedScope = request.scope || "(none)";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Least OAuth approval</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07090d;
      --panel: #10141b;
      --line: rgba(148, 163, 184, 0.18);
      --line-strong: rgba(148, 163, 184, 0.28);
      --text: #f4f7fb;
      --soft: #cbd5e1;
      --muted: #8a96a8;
      --blue: #7dd3fc;
      --teal: #5eead4;
      --red: #fda4af;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 18% 0, rgba(94, 234, 212, 0.14), transparent 28rem),
        radial-gradient(circle at 100% 10%, rgba(125, 211, 252, 0.1), transparent 26rem),
        var(--bg);
      color: var(--text);
      font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(760px, 100%);
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.018)), var(--panel);
      box-shadow: 0 24px 60px rgba(0,0,0,0.34);
    }
    h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 44px); line-height: 1; }
    p { margin: 0 0 18px; color: var(--soft); }
    .meta { display: grid; gap: 10px; margin-bottom: 22px; }
    .row {
      display: grid;
      grid-template-columns: 140px minmax(0, 1fr);
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
    }
    .row:last-child { border-bottom: 0; }
    .label { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--soft);
      overflow-wrap: anywhere;
    }
    form { display: flex; gap: 12px; flex-wrap: wrap; }
    button {
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      padding: 10px 16px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      color: var(--text);
      background: rgba(125, 211, 252, 0.12);
    }
    button[value="1"][name="approve"] { border-color: rgba(94, 234, 212, 0.32); }
    button[value="1"][name="deny"] {
      border-color: rgba(253, 164, 175, 0.28);
      background: rgba(253, 164, 175, 0.1);
      color: var(--red);
    }
    @media (max-width: 640px) {
      main { padding: 20px; }
      .row { grid-template-columns: 1fr; gap: 4px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Approve Grok access?</h1>
    <p>Least is running locally. Approving returns your existing Least bearer token to Grok so it can call this workspace MCP server.</p>
    <section class="meta">
      <div class="row"><span class="label">Workspace</span><code>${escapeHtml(config.defaultRoot)}</code></div>
      <div class="row"><span class="label">Client ID</span><code>${escapeHtml(request.clientId)}</code></div>
      <div class="row"><span class="label">Redirect URI</span><code>${escapeHtml(request.redirectUri)}</code></div>
      <div class="row"><span class="label">Scope</span><code>${escapeHtml(requestedScope)}</code></div>
    </section>
    <form method="post" action="/oauth/approve">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="client_id" value="${escapeHtml(request.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(request.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(request.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="S256">
      <input type="hidden" name="scope" value="${escapeHtml(request.scope)}">
      <input type="hidden" name="resource" value="${escapeHtml(request.resource ?? "")}">
      <input type="hidden" name="state" value="${escapeHtml(request.state ?? "")}">
      <button type="submit" name="approve" value="1">Approve</button>
      <button type="submit" name="deny" value="1">Deny</button>
    </form>
  </main>
</body>
</html>`;
}

function appendRedirectParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function pkceDigest(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface GrokOAuthRouteOptions {
  resourcePath?: string;
}

export function mountGrokOAuthRoutes(
  app: express.Express,
  config: LeastConfig,
  options: GrokOAuthRouteOptions = {}
): void {
  const resourceSuffix = options.resourcePath ?? "";
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const origin = requestOrigin(req);
    const resource = resourceSuffix ? `${origin}${resourceSuffix}` : origin;
    res.json({
      resource,
      authorization_servers: [origin],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/setup`
    });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const origin = requestOrigin(req);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"]
    });
  });

  app.get("/oauth/authorize", (req, res) => {
    cleanupPendingCodes();
    const parsed = parseAuthorizationRequest(req.query as Record<string, unknown>, config);
    if ("error" in parsed) {
      invalidRequest(res);
      return;
    }
    res.type("html").send(authorizationPage(config, parsed));
  });

  app.post("/oauth/approve", (req, res) => {
    cleanupPendingCodes();
    const parsed = parseAuthorizationRequest(req.body as Record<string, unknown>, config);
    if ("error" in parsed) {
      invalidRequest(res);
      return;
    }
    if (readString(req.body as Record<string, unknown>, "deny") === "1") {
      res.redirect(302, appendRedirectParams(parsed.redirectUri, { error: "access_denied", state: parsed.state }));
      return;
    }
    if (readString(req.body as Record<string, unknown>, "approve") !== "1") {
      invalidRequest(res);
      return;
    }
    const code = randomUUID().replace(/-/g, "");
    pendingCodes.set(code, {
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      codeChallenge: parsed.codeChallenge,
      scope: parsed.scope || "mcp",
      resource: parsed.resource,
      createdAt: Date.now()
    });
    res.redirect(302, appendRedirectParams(parsed.redirectUri, { code, state: parsed.state }));
  });

  app.post("/oauth/token", (req, res) => {
    cleanupPendingCodes();
    const body = req.body as Record<string, unknown>;
    const grantType = readString(body, "grant_type");
    const code = readString(body, "code");
    const clientId = readString(body, "client_id");
    const redirectUri = readString(body, "redirect_uri");
    const codeVerifier = readString(body, "code_verifier");
    const resource = readString(body, "resource");

    if (
      grantType !== "authorization_code" ||
      !code ||
      !clientId ||
      !redirectUri ||
      !codeVerifier
    ) {
      invalidRequest(res);
      return;
    }

    const pending = pendingCodes.get(code);
    if (!pending) {
      debugOAuthGrant("missing_code", { codeLength: code.length });
      invalidGrant(res);
      return;
    }
    pendingCodes.delete(code);

    const verifierChallenge = pkceDigest(codeVerifier);
    const reason =
      clientId !== config.grokOAuthClientId
        ? "client_id_config"
        : pending.clientId !== clientId
          ? "client_id_pending"
          : pending.redirectUri !== redirectUri
            ? "redirect_uri"
            : pending.resource && resource && pending.resource !== resource
              ? "resource"
              : Date.now() - pending.createdAt > CODE_TTL_MS
                ? "expired_code"
                : verifierChallenge !== pending.codeChallenge
                  ? "pkce"
                  : "";
    if (reason) {
      debugOAuthGrant(reason, {
        pendingClientId: pending.clientId,
        clientId,
        pendingRedirectUri: pending.redirectUri,
        redirectUri,
        pendingResource: pending.resource,
        resource,
        verifierChallenge,
        pendingCodeChallenge: pending.codeChallenge
      });
      invalidGrant(res);
      return;
    }

    res.json({
      access_token: config.authToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: pending.scope || "mcp"
    });
  });
}
