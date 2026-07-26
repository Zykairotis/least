import path from "node:path";
import type { WorkflowContext, WorkflowDefinition, WorkflowPlan, WorkflowStep } from "../../workflowTypes.js";

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function outputs(input: Record<string, unknown>): string[] {
  const raw = input.outputs;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  const csv = str(input, "outputs");
  return csv ? csv.split(",").map((item) => item.trim()).filter(Boolean) : ["obsidian", "anki", "images"];
}

function parseWindowScope(value: string | undefined): string[] {
  if (!value) return ["00:00-10:00", "10:00-20:00", "20:00-30:00"];
  const normalized = value.replace(/\s+/g, "");
  const range = normalized.match(/^(\d+)-(\d+)$/);
  if (!range) return normalized.split(",").filter(Boolean);
  const start = Number(range[1]);
  const end = Number(range[2]);
  const windows: string[] = [];
  for (let minute = start; minute < end; minute += 10) {
    const next = Math.min(minute + 10, end);
    windows.push(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}-${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`);
  }
  return windows.length ? windows : ["00:00-10:00"];
}

function lessonFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const base = path.basename(source).replace(/\.[^.]+$/, "");
  return base || undefined;
}

export const videoStudyWorkflow: WorkflowDefinition = {
  id: "video-study",
  title: "Video Study",
  description: "Plan and run bounded video-study batches with Video RAG, Obsidian, Anki, selected images, and optional Todoist.",
  plan(input: Record<string, unknown>, context: WorkflowContext): WorkflowPlan {
    const source = str(input, "source") ?? str(input, "folder") ?? str(input, "path") ?? "<missing source>";
    const project = str(input, "project") ?? "default";
    const course = str(input, "course");
    const module = str(input, "module");
    const lesson = str(input, "lesson") ?? lessonFromSource(source) ?? "<detect lesson>";
    const mode = str(input, "mode") ?? "time-window";
    const requestedOutputs = new Set(outputs(input));
    const windows = parseWindowScope(str(input, "window_scope") ?? str(input, "windows"));
    const steps: WorkflowStep[] = [];

    steps.push({
      id: "check-db",
      title: "Check Video RAG DB/index status before ingesting or writing artifacts.",
      capability: "video_rag.check_db",
      status: "pending"
    });
    steps.push({
      id: "read-existing-state",
      title: "Read existing Obsidian progress and Anki cards for duplicate/resume checks.",
      capability: "workflow.read_existing_state",
      status: "pending"
    });

    for (const window of windows) {
      const idWindow = window.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "");
      steps.push({
        id: `evidence-${idWindow}`,
        title: `Collect timestamped evidence for ${lesson} ${window}.`,
        capability: "video_rag.search_window",
        window,
        status: "pending",
        detail: { project, course, module, lesson }
      });
      if (requestedOutputs.has("images")) {
        steps.push({
          id: `images-${idWindow}`,
          title: `Select 0-2 useful frames and optimize image copies for ${window}.`,
          capability: "images.optimize_selected",
          window,
          sideEffect: true,
          status: "pending"
        });
      }
      if (requestedOutputs.has("obsidian")) {
        steps.push({
          id: `note-${idWindow}`,
          title: `Write/update Obsidian note section and progress for ${window}.`,
          capability: "obsidian.write_note_section",
          window,
          sideEffect: true,
          status: "pending"
        });
      }
      if (requestedOutputs.has("anki")) {
        steps.push({
          id: `anki-${idWindow}`,
          title: `Create non-duplicate Anki cards for ${window}.`,
          capability: "anki.add_cards",
          window,
          sideEffect: true,
          status: "pending"
        });
      }
    }

    const sideEffects = steps.filter((step) => step.sideEffect).length;
    const bulk = windows.length > context.settings.maxStepsDefault || mode.includes("batch") || sideEffects > 6;
    const confirmationRequired = Boolean(context.settings.requireConfirmationForBulk && bulk);
    return {
      workflowId: "video-study",
      title: `Video study: ${lesson}`,
      summary: `Plan for ${source} using project ${project}. Mode: ${mode}. Windows: ${windows.join(", ")}.`,
      steps,
      requiredCapabilities: [...new Set(steps.map((step) => step.capability).filter((value): value is string => Boolean(value)))],
      confirmationRequired,
      confirmationReason: confirmationRequired ? "Bulk/windowed side effects require confirmation before live execution." : undefined,
      nextAction: confirmationRequired ? "Review the plan, then rerun with confirm=true for live side effects or dry_run=true for preview." : "Run with max_steps to execute the next bounded batch."
    };
  }
};
