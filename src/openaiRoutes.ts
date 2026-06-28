import { randomUUID } from "node:crypto";
import type express from "express";
import { z } from "zod";
import type { LeastConfig } from "./config.js";
import type { ToolRegistry } from "./toolRegistry.js";
import { getSharedWorkspaceManager } from "./workspaceManager.js";

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string()
  })
});

const chatCompletionSchema = z.object({
  model: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(toolCallSchema).optional(),
      tool_call_id: z.string().optional()
    })
  ),
  tools: z.array(z.unknown()).optional(),
  stream: z.boolean().optional(),
  tool_choice: z.unknown().optional()
});

type OpenAiToolCall = z.infer<typeof toolCallSchema>;

function openAiError(
  res: express.Response,
  status: number,
  message: string,
  code: string,
  type = "invalid_request_error"
): void {
  res.status(status).json({ error: { message, type, code } });
}

function findLastAssistantToolCalls(
  messages: z.infer<typeof chatCompletionSchema>["messages"]
): OpenAiToolCall[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      return msg.tool_calls;
    }
  }
  return undefined;
}

function mergeWorkspaceId(
  args: Record<string, unknown>,
  workspaceId: string | undefined
): Record<string, unknown> {
  if (!workspaceId) return args;
  if (typeof args.workspace_id === "string" && args.workspace_id.length > 0) {
    return args;
  }
  return { ...args, workspace_id: workspaceId };
}

async function executeToolCalls(
  config: LeastConfig,
  registry: ToolRegistry,
  req: express.Request,
  toolCalls: OpenAiToolCall[]
): Promise<string> {
  const workspaces = getSharedWorkspaceManager(config);
  const headerWs = req.headers["x-least-workspace-id"];
  const workspaceId =
    typeof headerWs === "string" && headerWs.trim().length > 0
      ? headerWs.trim()
      : workspaces.defaultWorkspace().id;

  const sections: string[] = [];
  for (const call of toolCalls) {
    const name = call.function.name;
    const tool = registry.get(name);
    if (!tool) {
      const allowed = registry
        .list()
        .map((t) => t.name)
        .join(", ");
      throw new Error(`Unknown tool ${name}. Allowed tools: ${allowed}`);
    }
    let parsed: Record<string, unknown>;
    try {
      const raw = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      } else {
        parsed = {};
      }
    } catch {
      const err = new Error(`Invalid JSON in tool arguments for ${name}`);
      (err as Error & { code?: string }).code = "least_invalid_tool_arguments";
      throw err;
    }
    const merged = mergeWorkspaceId(parsed, workspaceId);
    const result = await registry.invoke(name, merged);
    const prefix = result.isError ? "ERROR:" : "";
    sections.push(`### tool:${name} (id=${call.id})\n${prefix}${result.content}\n`);
  }
  return sections.join("\n");
}

function writeSseChunk(
  res: express.Response,
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
): void {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function mountOpenAiRoutes(
  app: express.Express,
  config: LeastConfig,
  registry: ToolRegistry
): void {
  const modelCard = {
    id: "least-tools",
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "least"
  };

  app.get("/v1/models", (_req, res) => {
    res.json({ object: "list", data: [modelCard] });
  });

  app.get("/v1/models/least-tools", (_req, res) => {
    res.json(modelCard);
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const parsed = chatCompletionSchema.safeParse(req.body);
    if (!parsed.success) {
      openAiError(res, 400, parsed.error.message, "least_invalid_request");
      return;
    }

    const toolCalls = findLastAssistantToolCalls(parsed.data.messages);
    if (!toolCalls) {
      openAiError(
        res,
        400,
        "Least v1 does not run a chat model. Include an assistant message with tool_calls to execute workspace tools.",
        "least_no_tool_calls"
      );
      return;
    }

    const model = parsed.data.model ?? "least-tools";
    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "")}`;

    try {
      const aggregated = await executeToolCalls(config, registry, req, toolCalls);

      if (parsed.data.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        writeSseChunk(res, completionId, model, { role: "assistant" }, null);
        for (const call of toolCalls) {
          writeSseChunk(
            res,
            completionId,
            model,
            { content: `Executing ${call.function.name}...\n` },
            null
          );
        }
        writeSseChunk(res, completionId, model, { content: aggregated }, null);
        writeSseChunk(res, completionId, model, {}, "stop");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.json({
        id: completionId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: aggregated },
            finish_reason: "stop"
          }
        ]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : message.startsWith("Unknown tool")
            ? "least_unknown_tool"
            : "server_error";
      const status = code === "least_unknown_tool" ? 404 : code === "least_invalid_tool_arguments" ? 400 : 500;
      const type = status === 500 ? "server_error" : "invalid_request_error";
      if (parsed.data.stream && !res.headersSent) {
        openAiError(res, status, message, code, type);
        return;
      }
      if (!res.headersSent) {
        openAiError(res, status, message, code, type);
      }
    }
  });
}