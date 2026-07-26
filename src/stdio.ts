#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLeastServer, type SessionContext } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const sessionRef: { current: SessionContext } = {
    current: { sessionId: `stdio-${randomUUID()}` }
  };
  const { server, registry } = createLeastServer(config, { sessionContext: { get: () => sessionRef.current } });
  if (process.env.LEAST_PRINT_TOOLS === "1") {
    const toolNames = registry.list().map((tool) => tool.name).join(", ");
    console.error(`[LeastTools] stdio: ${toolNames}`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
