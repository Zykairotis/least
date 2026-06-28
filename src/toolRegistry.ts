import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type LeastToolCallResult = { content: string; isError?: boolean };
export type LeastToolHandler = (args: Record<string, unknown>) => Promise<LeastToolCallResult>;

export interface LeastToolRecord {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: LeastToolHandler;
}

export type McpToolContentBlock = { type?: string; text?: string };
export type McpToolResultShape = {
  isError?: boolean;
  content?: McpToolContentBlock[];
  structuredContent?: Record<string, unknown>;
};

/** Pull assistant-visible text from an MCP tool result payload. */
export function mcpToolResultToText(result: McpToolResultShape | undefined): string {
  if (!result) return "";
  const blocks = result.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block && typeof block.text === "string" && block.text.length > 0) {
        return block.text;
      }
    }
  }
  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return "";
}

function zodShapeFromInputSchema(inputSchema: Record<string, unknown>): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value instanceof z.ZodType) {
      shape[key] = value;
    }
  }
  return shape;
}

export function inputSchemaToJsonSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(inputSchema);
  if (keys.length === 0) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const schema = z.object(zodShapeFromInputSchema(inputSchema));
  const converted = zodToJsonSchema(schema, { $refStrategy: "none" });
  if (converted && typeof converted === "object") {
    return converted as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

export class ToolRegistry {
  private readonly tools = new Map<string, LeastToolRecord>();

  register(record: LeastToolRecord): void {
    this.tools.set(record.name, record);
  }

  list(): LeastToolRecord[] {
    return [...this.tools.values()];
  }

  get(name: string): LeastToolRecord | undefined {
    return this.tools.get(name);
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<LeastToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args);
  }
}