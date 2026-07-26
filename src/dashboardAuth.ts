import { timingSafeEqual } from "node:crypto";
import type express from "express";
import type { LeastConfig } from "./config.js";

export function createDashboardAuthMiddleware(
  config: LeastConfig
): express.RequestHandler {
  const token = config.dashboardToken;
  return (req, res, next) => {
    // Loopback always allowed
    const ip = req.ip || req.socket.remoteAddress || "";
    const host = req.hostname || "127.0.0.1";
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || host === "127.0.0.1" || host === "localhost") {
      if (!token) {
        next();
        return;
      }
    }

    // Non-loopback requires token
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    const queryToken =
      typeof req.query.dashboard_token === "string"
        ? req.query.dashboard_token
        : undefined;
    const matches = (value: unknown): boolean => {
      if (!token || typeof value !== "string") return false;
      const expected = Buffer.from(token);
      const actual = Buffer.from(value);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    };
    if (!matches(bearer) && !matches(queryToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    next();
  };
}
