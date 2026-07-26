import type { LeastConfig, HttpToolsConfig } from "./config.js";
import { LeastError } from "./guard.js";
import { redactSensitiveText, redactStructured } from "./redact.js";
import { resolveJsonPointer } from "./jsonQueryOps.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface LocalHttpRequestInput {
  method: HttpMethod;
  url?: string;
  baseUrl?: string;
  path?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  origin?: string;
  json?: unknown;
  bodyText?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  followRedirects?: boolean;
}

export interface LocalHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  durationMs: number;
  headers: Record<string, string>;
  json?: unknown;
  bodyText: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface ApiSmokeCheck {
  name?: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  expectedStatus?: number | number[];
  expectJsonPath?: Array<{
    path: string;
    equals?: unknown;
    exists?: boolean;
    type?: "string" | "number" | "boolean" | "array" | "object" | "null";
  }>;
}

export interface ApiSmokeSuiteInput {
  baseUrl: string;
  origin?: string;
  checks: ApiSmokeCheck[];
  stopOnFailure?: boolean;
  timeoutMs?: number;
}

export interface ApiSmokeCheckResult {
  name: string;
  ok: boolean;
  status?: number;
  durationMs?: number;
  failures: string[];
  response?: LocalHttpResponse;
  error?: string;
}

export interface ApiSmokeSuiteResult {
  ok: boolean;
  passed: number;
  failed: number;
  checks: ApiSmokeCheckResult[];
}

const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];

export function httpToolsFromConfig(config: LeastConfig): HttpToolsConfig {
  return config.httpTools;
}

export function normalizeHostname(hostname: string): string {
  const raw = hostname.trim().toLowerCase();
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
}

export function isAllowedHost(hostname: string, settings: HttpToolsConfig): boolean {
  if (settings.allowExternal) return true;
  const host = normalizeHostname(hostname);
  const allowed = settings.allowedHosts.map(normalizeHostname);
  return allowed.includes(host);
}

export function buildUrl(
  baseUrl: string | undefined,
  pathPart: string | undefined,
  query: Record<string, string | number | boolean | null | undefined> | undefined,
  url?: string
): URL {
  let target: URL;
  if (url) {
    target = new URL(url);
  } else if (baseUrl) {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const rel = (pathPart ?? "").replace(/^\//, "");
    target = new URL(rel, base);
  } else {
    throw new LeastError("Provide either url or baseUrl (+ optional path).");
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      target.searchParams.set(key, String(value));
    }
  }
  return target;
}

export function validateLocalHttpUrl(input: LocalHttpRequestInput, settings: HttpToolsConfig): URL {
  const target = buildUrl(input.baseUrl, input.path, input.query, input.url);

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new LeastError(`Blocked protocol: ${target.protocol}. Only http/https are allowed.`);
  }
  if (target.username || target.password) {
    throw new LeastError("URLs with embedded credentials are blocked.");
  }
  if (!isAllowedHost(target.hostname, settings)) {
    throw new LeastError(
      `Host not allowed: ${target.hostname}. Allowed hosts: ${settings.allowedHosts.join(", ")}. ` +
        "Set http.allowExternal or --http-allow-host to permit additional hosts."
    );
  }
  if (settings.allowedPorts.length > 0) {
    const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    if (!settings.allowedPorts.includes(port)) {
      throw new LeastError(`Port not allowed: ${port}. Allowed ports: ${settings.allowedPorts.join(", ")}.`);
    }
  }
  return target;
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function parseMaybeJson(bodyText: string, contentType: string | undefined): unknown | undefined {
  if (!bodyText) return undefined;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json") || looksLikeJson(bodyText)) {
    try {
      return JSON.parse(bodyText);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function localHttpRequest(
  input: LocalHttpRequestInput,
  config: LeastConfig,
  fetchImpl: typeof fetch = fetch
): Promise<LocalHttpResponse> {
  const settings = httpToolsFromConfig(config);
  if (!settings.enabled) {
    throw new LeastError("HTTP tools are disabled. Enable with --http-tools or settings.http.enabled.");
  }

  const target = validateLocalHttpUrl(input, settings);
  const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? settings.defaultTimeoutMs, 600_000));
  const maxBodyBytes = Math.max(1, Math.min(input.maxBodyBytes ?? settings.maxBodyBytes, 20_000_000));
  const followRedirects = input.followRedirects ?? settings.allowRedirects;

  const headers = new Headers(input.headers ?? {});
  if (input.origin) headers.set("Origin", input.origin);

  let body: string | undefined;
  if (input.json !== undefined) {
    body = JSON.stringify(input.json);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  } else if (input.bodyText !== undefined) {
    body = input.bodyText;
  }

  const method = input.method.toUpperCase() as HttpMethod;
  if ((method === "GET" || method === "HEAD") && body !== undefined) {
    throw new LeastError(`${method} requests cannot include a body.`);
  }

  const controller = new AbortController();
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timed out after ${timeoutMs}ms.`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  try {
    let currentUrl = target;
    let response: Response | undefined;
    let responseHeaders: Record<string, string> = {};
    const maxRedirects = followRedirects ? 10 : 0;

    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      response = await Promise.race([
        fetchImpl(currentUrl.toString(), {
          method,
          headers,
          body,
          redirect: "manual",
          signal: controller.signal
        }),
        timeoutPromise
      ]);
      responseHeaders = headerRecord(response.headers);

      if (response.status < 300 || response.status >= 400) break;

      const location = responseHeaders.location;
      if (!followRedirects) {
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          url: currentUrl.toString(),
          durationMs: Date.now() - started,
          headers: redactStructured(responseHeaders) as Record<string, string>,
          bodyText: location ? `Redirect to ${location} (redirects disabled)` : "Redirect (redirects disabled)",
          truncated: false,
          timedOut: false
        };
      }

      if (!location) break;
      if (redirects >= maxRedirects) {
        throw new LeastError(`Too many redirects after ${maxRedirects} hops.`);
      }

      const nextUrl = new URL(location, currentUrl);
      validateLocalHttpUrl({ method, url: nextUrl.toString() }, settings);
      currentUrl = nextUrl;
    }

    if (!response) {
      throw new LeastError("HTTP request failed: no response.");
    }

    if (method === "HEAD") {
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url || currentUrl.toString(),
        durationMs: Date.now() - started,
        headers: redactStructured(responseHeaders) as Record<string, string>,
        bodyText: "",
        truncated: false,
        timedOut: false
      };
    }

    // Prefer arrayBuffer then decode with size cap.
    const buf = Buffer.from(await response.arrayBuffer());
    let truncated = false;
    let bodyBuf = buf;
    if (buf.byteLength > maxBodyBytes) {
      bodyBuf = buf.subarray(0, maxBodyBytes);
      truncated = true;
    }
    const bodyText = bodyBuf.toString("utf8");
    const json = parseMaybeJson(bodyText, responseHeaders["content-type"]);

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url || currentUrl.toString(),
      durationMs: Date.now() - started,
      headers: redactStructured(responseHeaders) as Record<string, string>,
      json: json === undefined ? undefined : redactStructured(json),
      bodyText: redactSensitiveText(bodyText),
      truncated,
      timedOut: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";
    const timedOut =
      controller.signal.aborted ||
      /timed out/i.test(message) ||
      name === "AbortError" ||
      name === "TimeoutError";
    if (timedOut) {
      return {
        ok: false,
        status: 0,
        statusText: "Timeout",
        url: target.toString(),
        durationMs: Date.now() - started,
        headers: {},
        bodyText: `Timed out after ${timeoutMs}ms.`,
        truncated: false,
        timedOut: true
      };
    }
    throw new LeastError(`HTTP request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function localHttpJson(
  input: Omit<LocalHttpRequestInput, "bodyText" | "headers"> & { headers?: Record<string, string> },
  config: LeastConfig,
  fetchImpl: typeof fetch = fetch
): Promise<LocalHttpResponse> {
  const headers: Record<string, string> = { Accept: "application/json", ...(input.headers ?? {}) };
  if (input.json !== undefined && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  return localHttpRequest({ ...input, headers }, config, fetchImpl);
}

function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function checkExpectations(
  check: ApiSmokeCheck,
  response: LocalHttpResponse
): string[] {
  const failures: string[] = [];
  if (check.expectedStatus !== undefined) {
    const expected = Array.isArray(check.expectedStatus) ? check.expectedStatus : [check.expectedStatus];
    if (!expected.includes(response.status)) {
      failures.push(`expected status ${expected.join("|")}, got ${response.status}`);
    }
  }
  if (check.expectJsonPath?.length) {
    if (response.json === undefined) {
      failures.push("expected JSON body but response was not JSON");
    } else {
      for (const expectation of check.expectJsonPath) {
        const value = resolveJsonPointer(response.json, expectation.path);
        if (expectation.exists === false) {
          if (value !== undefined) failures.push(`${expectation.path} should not exist`);
          continue;
        }
        if (expectation.exists === true || expectation.equals !== undefined || expectation.type) {
          if (value === undefined) {
            failures.push(`${expectation.path} missing`);
            continue;
          }
        }
        if (expectation.equals !== undefined) {
          const actual = JSON.stringify(value);
          const expected = JSON.stringify(expectation.equals);
          if (actual !== expected) {
            failures.push(`${expectation.path} expected ${expected}, got ${actual}`);
          }
        }
        if (expectation.type) {
          const actualType = typeOfValue(value);
          if (actualType !== expectation.type) {
            failures.push(`${expectation.path} expected type ${expectation.type}, got ${actualType}`);
          }
        }
      }
    }
  }
  return failures;
}

export async function apiSmokeSuite(
  input: ApiSmokeSuiteInput,
  config: LeastConfig,
  fetchImpl: typeof fetch = fetch
): Promise<ApiSmokeSuiteResult> {
  if (!input.checks?.length) {
    throw new LeastError("api_smoke_suite requires at least one check.");
  }
  const results: ApiSmokeCheckResult[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < input.checks.length; i += 1) {
    const check = input.checks[i];
    const name = check.name?.trim() || `check_${i + 1}`;
    try {
      const response =
        check.method === "HEAD"
          ? await localHttpRequest(
              {
                method: "HEAD",
                baseUrl: input.baseUrl,
                path: check.path,
                query: check.query,
                origin: input.origin,
                timeoutMs: input.timeoutMs
              },
              config,
              fetchImpl
            )
          : await localHttpJson(
              {
                method: check.method,
                baseUrl: input.baseUrl,
                path: check.path,
                query: check.query,
                origin: input.origin,
                json: check.json,
                timeoutMs: input.timeoutMs
              },
              config,
              fetchImpl
            );

      const failures = checkExpectations(check, response);
      const ok = failures.length === 0;
      if (ok) passed += 1;
      else failed += 1;
      results.push({
        name,
        ok,
        status: response.status,
        durationMs: response.durationMs,
        failures,
        response
      });
      if (!ok && input.stopOnFailure) break;
    } catch (error) {
      failed += 1;
      results.push({
        name,
        ok: false,
        failures: [error instanceof Error ? error.message : String(error)],
        error: error instanceof Error ? error.message : String(error)
      });
      if (input.stopOnFailure) break;
    }
  }

  return { ok: failed === 0, passed, failed, checks: results };
}

export function formatLocalHttpText(title: string, response: LocalHttpResponse): string {
  const lines = [
    `# ${title}`,
    "",
    `URL: ${response.url}`,
    `Status: ${response.status} ${response.statusText}`,
    `Duration: ${response.durationMs} ms`,
    `OK: ${response.ok}`,
    response.timedOut ? "Timed out: true" : "",
    response.truncated ? "Body truncated: true" : "",
    "",
    "## body",
    "",
    "```json",
    response.json !== undefined ? JSON.stringify(response.json, null, 2) : response.bodyText,
    "```"
  ].filter((line) => line !== undefined);
  return lines.join("\n");
}

export function formatApiSmokeText(result: ApiSmokeSuiteResult): string {
  const lines = [
    "# API Smoke Suite",
    "",
    `OK: ${result.ok}`,
    `Passed: ${result.passed}`,
    `Failed: ${result.failed}`,
    ""
  ];
  for (const check of result.checks) {
    lines.push(`## ${check.name}`);
    lines.push(`Result: ${check.ok ? "pass" : "fail"}`);
    if (check.status !== undefined) lines.push(`Status: ${check.status}`);
    if (check.durationMs !== undefined) lines.push(`Duration: ${check.durationMs} ms`);
    if (check.failures.length) {
      lines.push("Failures:");
      for (const failure of check.failures) lines.push(`- ${failure}`);
    }
    if (check.error) lines.push(`Error: ${check.error}`);
    lines.push("");
  }
  return lines.join("\n");
}
