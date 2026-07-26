import { timingSafeEqual } from "node:crypto";
import type express from "express";
import type { LeastConfig } from "./config.js";
import type { McpSurface } from "./server.js";

function requestOrigin(req: express.Request): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || `${req.hostname}`;
  return `${proto}://${host}`;
}

export interface HttpAuthOptions {
  surface?: McpSurface;
  oauthChallenge?: boolean;
}

export function createHttpAuthMiddleware(
  config: LeastConfig,
  options: HttpAuthOptions = {}
): express.RequestHandler {
  const oauthChallenge = options.oauthChallenge ?? false;
  return (req, res, next) => {
    if (!config.authToken) {
      next();
      return;
    }
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    const queryToken =
      typeof req.query.least_token === "string"
        ? req.query.least_token
        : typeof req.query.token === "string"
          ? req.query.token
          : undefined;
    const matches = (value: unknown): boolean => {
      if (!config.authToken || typeof value !== "string") return false;
      const expected = Buffer.from(config.authToken);
      const actual = Buffer.from(value);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    };
    if (!matches(bearer) && !matches(queryToken)) {
      if (oauthChallenge) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${requestOrigin(req)}/.well-known/oauth-protected-resource"`
        );
      }
      res.status(401).send("Unauthorized");
      return;
    }
    next();
  };
}