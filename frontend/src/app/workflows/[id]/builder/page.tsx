"use client";

import { validateGraphIntegrity } from "@/utils/graphValidation";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Card } from "@/components/ui/card";
import { AuthGuard } from "@/components/auth/auth-guard";
import { useAssistantContext } from "@/context/assistant-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import VisualBuilder from "@/components/workflow/visual-builder";
import { Textarea } from "@/components/ui/textarea";
import { useEffect } from "react";
import { Save, Play, Plus, Trash2 } from "lucide-react";
import { generateNodeId } from "@/utils/ids"; // ✅ Using centralized ID system
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnimatePresence, motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/api";

/* ---------------- TYPES ---------------- */

type StepType =
  | "LLM"
  | "HTTP"
  | "Delay"
  | "Tool"
  | "Document"
  | "Condition"
  | "Switch"
  | "GitHub"
  | "Slack"
  | "Discord";
type ToolType = "email" | "file" | "browser";

type WorkflowStep = {
  id: string;
  type: StepType;
  name: string;

  position?: {
    x: number;
    y: number;
  };

  // LLM
  useMemory?: boolean;
  memoryTopK?: number;
  prompt?: string;

  // HTTP
  url?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: string;

  // Delay
  delay?: number;

  // 🔥 Tool
  tool?: ToolType;

  // Email
  to?: string;
  subject?: string;
  text?: string;
  html?: string;

  // File
  action?: string;
  path?: string;
  content?: string;

  // Browser
  code?: string;

  // Document RAG
  documentId?: string;
  query?: string;
  topK?: number;

  // CONDITION (NEW SYSTEM)
  conditionType?: "boolean" | "sentiment" | "contains";
  operator?: string;
  value?: string;

  trueTarget?: string;
  falseTarget?: string;

  // GitHub
  owner?: string;
  repo?: string;
  issue_number?: string;
  comment?: string;
  title?: string;

  // SWITCH
  cases?: {
    value: string; // what to match
    target: string; // stepId
  }[];

  defaultTarget?: string;
};

type BackendStep = {
  name: string;
  stepId: string;
  type:
    | "LLM"
    | "HTTP"
    | "Delay"
    | "Tool"
    | "llm"
    | "http"
    | "delay"
    | "condition"
    | "switch"
    | "document_query"
    | "file"
    | "email"
    | "browser"
    | "github"
    | "slack"
    | "discord";

  prompt?: string;

  url?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: string;

  seconds?: number;
};

type WorkflowResponse = {
  _id: string;
  name: string;
  metadata?: {
    steps?: BackendStep[];
    edges?: any[];
  };
};

/* ---------------- UTILS ---------------- */

function getTypeColor(type: StepType) {
  switch (type) {
    case "LLM":
      return "bg-primary/20 text-primary border-primary/30";
    case "HTTP":
      return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    case "Delay":
      return "bg-purple-500/20 text-purple-400 border-purple-500/30";
    case "Tool":
      return "bg-green-500/20 text-green-400 border-green-500/30";
    case "Document":
      return "bg-orange-500/20 text-orange-400 border-orange-500/30";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function summarizeStep(step: WorkflowStep) {
  switch (step.type) {
    case "LLM":
      return step.prompt
        ? `Prompt: ${step.prompt.slice(0, 120)}${
            step.prompt.length > 120 ? "…" : ""
          }`
        : "No prompt configured";

    case "HTTP": {
      const method = step.method ?? "GET";
      const url = step.url?.trim() || "❌ not set";
      const body = step.body?.trim();
      let bodyStatus = "none";

      if (body) {
        try {
          JSON.parse(body);
          bodyStatus = "valid JSON";
        } catch {
          bodyStatus = "invalid JSON";
        }
      }
      return [`Method: ${method}`, `URL: ${url}`, `Body: ${bodyStatus}`].join(" | ");
    }

    case "Delay":
      return `Delay for ${step.delay ?? 0} seconds`;

    case "Document":
      return step.query
        ? `Query: ${step.query.slice(0, 120)}${
            step.query.length > 120 ? "…" : ""
          }`
        : "No query configured";

    case "Tool": {
      if (!step.tool) return "Tool not selected";
      if (step.tool === "email") {
        return `Email → ${step.to || "❌ no recipient"} | Subject: ${step.subject || "no subject"}`;
      }
      if (step.tool === "file") {
        return `File ${step.action || "action"} | Path: ${step.path || "❌ path not set"}`;
      }
      if (step.tool === "browser") {
        return `Browser ${step.action || "action"} | URL: ${step.url || "❌ url not set"}`;
      }
      return "Tool execution step";
    }
    default:
      return "Unknown step";
  }
}

export default function WorkflowBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [workflowName, setWorkflowName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<any[]>([]);
  const [builderMode, setBuilderMode] = useState<"list" | "visual">("list");
  const { addToast } = useToast();
  const [edges, setEdges] = useState<any[]>([]);
  const { setContext, clearContext } = useAssistantContext();

  async function fetchWorkflow() {
    try {
      const res = await fetch(apiUrl(`/workflows/${id}`), {
        headers: {
          Authorization: "Bearer " + localStorage.getItem("token"),
        },
      });

      const data = await res.json();
      if (!data.ok) return;

      const workflow: WorkflowResponse = data.workflow;
      setWorkflowName(workflow.name);

      const backendSteps = workflow.metadata?.steps ?? [];
      const backendEdges = (workflow.metadata?.edges ?? []).map((e: any) => ({
        ...e,
        id: e.id || generateNodeId("edge"), // ✅ Safe parsing fallback
        label: e.label || e.caseValue || e.condition?.toUpperCase() || "",
      }));
      setEdges(backendEdges);

      const normalizedSteps: WorkflowStep[] = backendSteps.map((s) => ({
        id: s.stepId,
        name: s.name,
          type:
          s.type === "delay"
            ? "Delay"
            : s.type === "http"
              ? "HTTP"
              : s.type === "condition"
                ? "Condition"
                : s.type === "switch"
                  ? "Switch"
                  : s.type === "document_query"
                    ? "Document"
                    : s.type === "github"
                      ? "GitHub"
                      : s.type === "slack"
                        ? "Slack"
                        : s.type === "discord"
                          ? "Discord"
                          : s.type === "file" ||
                              s.type === "email" ||
                              s.type === "browser"
                            ? "Tool"
                            : "LLM",

        position: (s as any).position || { x: 0, y: 0 },
        useMemory: (s as any).useMemory ?? false,
        memoryTopK: (s as any).memoryTopK ?? 5,
        prompt: s.prompt ?? "",
        url: s.url ?? "",
        method: s.method ?? "GET",
        body: s.body ?? "",
        delay: s.type === "delay" ? (s.seconds ?? 0) : 0,
        tool:
          s.type === "file" || s.type === "email" || s.type === "browser"
            ? (s.type as ToolType)
            : undefined,
        to: (s as any).to ?? "",
        subject: (s as any).subject ?? "",
        text: (s as any).text ?? "",
        html: (s as any).html ?? "",
        action: (s as any).action ?? "",
        path: (s as any).path ?? "",
        content: (s as any).content ?? "",
        code: (s as any).code ?? "",
        documentId: (s as any).documentId ?? "",
        query: (s as any).query ?? "",
        topK: (s as any).topK ?? 4,
        conditionType: (s as any).conditionType ?? "",
        operator: (s as any).operator ?? "",
        value: (s as any).value ?? "",
        trueTarget: (s as any).trueTarget ?? "",
        falseTarget: (s as any).falseTarget ?? "",
        cases: (s as any).cases ?? [],
        defaultTarget: (s as any).defaultTarget ?? "",
        owner: (s as any).owner ?? "",
        repo: (s as any).repo ?? "",
        issue_number: (s as any).issue_number ?? "",
        comment: (s as any).comment ?? "",
        title: (s as any).title ?? "",
      }));

      setSteps(normalizedSteps);
    } catch (err) {
      console.error("Failed to load workflow", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchWorkflow();
  }, [id]);

  useEffect(() => {
    if (!id) return;

    setContext({
      page: "workflow-builder",
      workflowId: id,
      workflowName: workflowName ?? undefined,
      status: "editing",
      builderSteps: steps
        .filter(
          (s) =>
            s.type === "LLM" ||
            s.type === "HTTP" ||
            s.type === "Tool" ||
            s.type === "Delay",
        )
        .map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type as "LLM" | "HTTP" | "Tool" | "Delay",
          summary: summarizeStep(s),
        })),
    });

    return () => {
      clearContext();
    };
  }, [id, workflowName, steps.length]);

  useEffect(() => {
    async function fetchDocs() {
      try {
        const res = await fetch(apiUrl("/documents"), {
          headers: {
            Authorization: "Bearer " + localStorage.getItem("token"),
          },
        });
        const data = await res.json();
        if (data.ok) {
          setDocuments(data.documents || []);
        }
      } catch (err) {
        console.error("Failed to fetch documents", err);
      }
    }
    fetchDocs();
  }, []);

  function addStep() {
    setSteps((prev) => [
      ...prev,
      {
        id: generateNodeId("LLM"), // ✅ Replaced random string mapping
        type: "LLM",
        name: "New Step",
        prompt: "",
      },
    ]);
  }

  function enrichStepsWithEdges(steps: WorkflowStep[], edges: any[]) {
    return steps.map((step) => {
      if (step.type === "Switch") {
        const outgoing = edges.filter((e) => e.source === step.id);
        const cases = outgoing
          .filter((e) => e.caseValue)
          .map((e) => ({
            value: e.caseValue,
            target: e.target,
          }));

        return {
          ...step,
          cases,
          defaultTarget: outgoing.find((e) => !e.caseValue)?.target,
        };
      }

      if (step.type === "Condition") {
        return {
          ...step,
          trueTarget: edges.find((e) => e.source === step.id && e.condition === "true")?.target,
          falseTarget: edges.find((e) => e.source === step.id && e.condition === "false")?.target,
        };
      }
      return step;
    });
  }

  async function saveWorkflow() {
    try {
      const enrichedSteps = enrichStepsWithEdges(steps, edges);

      const backendSteps = enrichedSteps.map((s) => {
        if (s.type === "LLM") {
          return {
            stepId: s.id,
            name: s.name,
            position: s.position,
            type: "llm",
            prompt: s.prompt ?? "",
            useMemory: s.useMemory ?? false,
            memoryTopK: s.memoryTopK ?? 5,
          };
        }
        if (s.type === "Delay") {
          return {
            stepId: s.id,
            name: s.name,
            position: s.position,
            type: "delay",
            seconds: s.delay ?? 0,
          };
        }
        if (s.type === "HTTP") {
          return {
            stepId: s.id,
            name: s.name,
            position: s.position,
            type: "http",
            method: s.method ?? "GET",
            url: s.url ?? "",
            body: s.body ?? "",
          };
        }
        if (s.type === "Document") {
          return {
            stepId: s.id,
            name: s.name,
            position: s.position,
            type: "document_query",
            documentId: s.documentId,
            query: s.query,
            topK: s.topK ?? 4,
          };
        }
        if (s.type === "Condition") {
          return {
            stepId: s.id,
            name: s.name,
            position: s.position,
            type: "condition",
            conditionType: s.conditionType,
            operator: s.operator,
            value: s.value,
            trueTarget: s.trueTarget,
            falseTarget: s.falseTarget,
          };
        }
        if (s.type === "Switch") {
          return {
            stepId: s.id,
            name: s.name,
            position: s.position,
            type: "switch",
          };
        }
        if (s.type === "Tool" && s.tool) {
          const toolType = s.tool.toLowerCase();
          const base: any = {
            stepId: s.id,
            name: s.name,
            position: s.position,
            type: toolType,
          };

          if (toolType === "file") {
            return {
              ...base,
              action: s.action ?? "read",
              path: s.path ?? "",
              content: s.content ?? "",
            };
          }
          if (toolType === "email") {
            return {
              ...base,
              to: s.to ?? "",
              subject: s.subject ?? "",
              text: s.text ?? "",
              html: s.html ?? "",
            };
          }
          if (toolType === "browser") {
            return {
              ...base,
              action: s.action ?? "screenshot",
              url: s.url ?? "",
              code: s.code ?? "",
            };
          }
          return base;
        }

          if (s.type === "GitHub") {
            return {
              stepId: s.id,
              name: s.name,
              position: s.position,
              type: "github",
              action: s.action ?? "",
              owner: (s as any).owner ?? "",
              repo: (s as any).repo ?? "",
              title: (s as any).title ?? "",
              body: s.body ?? "",
              issue_number: (s as any).issue_number ?? "",
              comment: (s as any).comment ?? "",
            };
          }

          if (s.type === "Slack") {
            return {
              stepId: s.id,
              name: s.name,
              position: s.position,
              type: "slack",
              action: s.action ?? "send_message",
              text: s.text ?? "",
            };
          }

          if (s.type === "Discord") {
            return {
              stepId: s.id,
              name: s.name,
              position: s.position,
              type: "discord",
              action: s.action ?? "send_message",
              content: s.content ?? "",
            };
          }
        // fallback (should never hit)
        return {
          stepId: s.id,
          name: s.name,
          position: s.position,
          type: "unknown" as any,
        };
      });

      // 🛡️ Final Graph Integrity Validation Check
      const validation = validateGraphIntegrity(enrichedSteps, edges);
      if (!validation.isValid) {
        console.error("Save workflow blocked due to validation errors:", validation.errors);
        addToast({
          type: "error",
          title: "Failed to Save Workflow",
          description: validation.errors[0] || "Your workflow contains orphaned edges or invalid connections. Please resolve them before saving.",
        });
        return; // Halt execution entirely
      }

      // 🚀 Topology is verified clean - proceed with secure API request
      const res = await fetch(apiUrl(`/workflows/${id}/steps`), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + localStorage.getItem("token"),
        },
        body: JSON.stringify({
          steps: backendSteps,
          edges: edges,
        }),
      });

      if (!res.ok) throw new Error("Failed to save workflow");

      addToast({
        type: "success",
        title: "Workflow saved",
        description: "Your workflow steps were updated successfully",
      });
    } catch (err) {
      console.error("Save workflow failed:", err);
      addToast({
        type: "error",
        title: "Failed to save workflow",
        description: "Something went wrong. Try again.",
      });
    }
  }

  function removeStep(stepId: string) {
    setSteps((prev) => prev.filter((s) => s.id !== stepId));
  }

  function updateStep(stepId: string, patch: Partial<WorkflowStep>) {
    setSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen">
        <AppSidebar />
        <main className="flex-1 pl-64 p-8">
          <p className="opacity-70">Loading workflow builder…</p>
        </main>
      </div>
    );
  }

  return (
    <AuthGuard>
      <div className="flex min-h-screen">
        <AppSidebar />

        <main
          className="flex-1 transition-[padding] duration-300"
          style={{ paddingLeft: "var(--sidebar-width, 256px)" }}
        >
          <div className="p-8">
            {/* Header */}
            <div className="mb-8 flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold">Workflow Builder</h1>
                <p className="mt-2 text-muted-foreground">
                  Configure workflow steps and execution order
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Workflow ID: {id}
                </p>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant={builderMode === "list" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setBuilderMode("list")}
                  >
                    Step Builder
                  </Button>

                  <Button
                    variant={builderMode === "visual" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setBuilderMode("visual")}
                  >
                    Visual Graph
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={() => router.push(`/workflows/${id}`)}
                >
                  ← Back to Workflow
                </Button>
                <Button variant="outline">
                  <Save className="mr-2 size-4" />
                  Save Draft
                </Button>
                <Button onClick={saveWorkflow}>
                  <Play className="mr-2 size-4" />
                  Save Changes
                </Button>
              </div>
            </div>

            {/* Render Canvas vs List view toggles */}
            {builderMode === "visual" && (
              <VisualBuilder
                steps={steps}
                setSteps={setSteps}
                edges={edges}
                onEdgesChange={(updatedEdges) => {
                  setEdges(updatedEdges);
                }}
                onSave={saveWorkflow}
              />
            )}

            {builderMode === "list" && (
              <div className="mx-auto max-w-3xl space-y-4">
                <AnimatePresence initial={false}>
                  {steps.map((step, index) => (
                    <motion.div
                      key={step.id}
                      layout
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -12, scale: 0.98 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                    >
                      <Card
                        className="p-6 transition-shadow hover:shadow-lg"
                        onClick={() => {
                          const validStepType = (
                            ["LLM", "HTTP", "Tool", "Delay"].includes(step.type)
                              ? step.type
                              : "LLM"
                          ) as "LLM" | "HTTP" | "Tool" | "Delay";

                          setContext({
                            page: "workflow-builder",
                            workflowId: id,
                            workflowName: workflowName ?? undefined,
                            status: "editing",
                            builderSteps: steps
                              .filter(
                                (s) =>
                                  s.type === "LLM" ||
                                  s.type === "HTTP" ||
                                  s.type === "Tool" ||
                                  s.type === "Delay",
                              )
                              .map((s) => ({
                                id: s.id,
                                name: s.name,
                                type: s.type as "LLM" | "HTTP" | "Delay" | "Tool",
                                summary: summarizeStep(s),
                              })),
                            stepId: step.id,
                            stepName: step.name,
                            stepType: validStepType,
                            stepDescription: summarizeStep(step),
                          });
                        }}
                      >
                        <div className="mb-4 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <motion.span
                              layout
                              className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                            >
                              {index + 1}
                            </motion.span>
                            <Badge
                              variant="outline"
                              className={getTypeColor(step.type)}
                            >
                              {step.type}
                            </Badge>
                          </div>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeStep(step.id);
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>

                        <div className="space-y-4">
                          <div>
                            <Label>Step Type</Label>
                            <Select
                              value={step.type}
                              onValueChange={(v) => {
                                const patch: Partial<WorkflowStep> = { type: v as StepType };
                                if (v === "Slack" || v === "Discord") patch.action = "send_message";
                                updateStep(step.id, patch);
                              }}
                            >
                              <SelectTrigger className="mt-1.5">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="LLM">LLM</SelectItem>
                                <SelectItem value="HTTP">HTTP Request</SelectItem>
                                <SelectItem value="Delay">Delay</SelectItem>
                                <SelectItem value="Tool">Tool</SelectItem>
                                <SelectItem value="Document">Document Query</SelectItem>
                                <SelectItem value="Condition">Condition</SelectItem>
                                <SelectItem value="Switch">Switch</SelectItem>
                                <SelectItem value="GitHub">GitHub</SelectItem>
                                <SelectItem value="Slack">Slack</SelectItem>
                                <SelectItem value="Discord">Discord</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div>
                            <Label>Step Name</Label>
                            <Input
                              className="mt-1.5"
                              value={step.name}
                              onChange={(e) =>
                                updateStep(step.id, {
                                  name: e.target.value,
                                })
                              }
                            />
                          </div>

                          {step.type === "Tool" && (
                            <>
                              <div>
                                <Label>Tool</Label>
                                <Select
                                  value={step.tool}
                                  onValueChange={(v) =>
                                    updateStep(step.id, { tool: v as any })
                                  }
                                >
                                  <SelectTrigger className="mt-1.5">
                                    <SelectValue placeholder="Select tool" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="email">Email</SelectItem>
                                    <SelectItem value="file">File</SelectItem>
                                    <SelectItem value="browser">Browser</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              {step.tool === "email" && (
                                <>
                                  <div>
                                    <Label>To</Label>
                                    <Input
                                      className="mt-1.5"
                                      value={step.to ?? ""}
                                      onChange={(e) =>
                                        updateStep(step.id, {
                                          to: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  <div>
                                    <Label>Subject</Label>
                                    <Input
                                      className="mt-1.5"
                                      value={step.subject ?? ""}
                                      onChange={(e) =>
                                        updateStep(step.id, {
                                          subject: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  <div>
                                    <Label>Text</Label>
                                    <Textarea
                                      className="mt-1.5"
                                      value={step.text ?? ""}
                                      onChange={(e) =>
                                        updateStep(step.id, {
                                          text: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                </>
                              )}

                              {step.tool === "file" && (
                                <>
                                  <div>
                                    <Label>Action</Label>
                                    <Select
                                      value={step.action}
                                      onValueChange={(v) =>
                                        updateStep(step.id, { action: v })
                                      }
                                    >
                                      <SelectTrigger className="mt-1.5">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="write">Write</SelectItem>
                                        <SelectItem value="append">Append</SelectItem>
                                        <SelectItem value="read">Read</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div>
                                    <Label>Path</Label>
                                    <Input
                                      className="mt-1.5"
                                      value={step.path ?? ""}
                                      onChange={(e) =>
                                        updateStep(step.id, {
                                          path: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  {step.action !== "read" && (
                                    <div>
                                      <Label>Content</Label>
                                      <Textarea
                                        className="mt-1.5"
                                        value={step.content ?? ""}
                                        onChange={(e) =>
                                          updateStep(step.id, {
                                            content: e.target.value,
                                          })
                                        }
                                      />
                                    </div>
                                  )}
                                </>
                              )}

                              {step.tool === "browser" && (
                                <>
                                  <div>
                                    <Label>Action</Label>
                                    <Select
                                      value={step.action}
                                      onValueChange={(v) =>
                                        updateStep(step.id, { action: v })
                                      }
                                    >
                                      <SelectTrigger className="mt-1.5">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="screenshot">Screenshot</SelectItem>
                                        <SelectItem value="evaluate">Evaluate</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div>
                                    <Label>URL</Label>
                                    <Input
                                      className="mt-1.5"
                                      value={step.url ?? ""}
                                      onChange={(e) =>
                                        updateStep(step.id, {
                                          url: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  {step.action === "evaluate" && (
                                    <div>
                                      <Label>Code</Label>
                                      <Textarea
                                        className="mt-1.5 font-mono text-sm"
                                        value={step.code ?? ""}
                                        onChange={(e) =>
                                          updateStep(step.id, {
                                            code: e.target.value,
                                          })
                                        }
                                      />
                                    </div>
                                  )}
                                </>
                              )}
                            </>
                          )}

                          {step.type === "LLM" && (
                            <>
                              <div>
                                <Label>Prompt</Label>
                                <Textarea
                                  className="mt-1.5 min-h-[100px] font-mono text-sm"
                                  value={step.prompt ?? ""}
                                  onChange={(e) =>
                                    updateStep(step.id, {
                                      prompt: e.target.value,
                                    })
                                  }
                                />
                              </div>
                              <div className="mt-4 rounded-lg border border-muted p-4">
                                <p className="text-sm font-semibold mb-3">Advanced Options</p>
                                <div className="flex items-center justify-between">
                                  <Label className="cursor-pointer">Use Agent Memory</Label>
                                  <input
                                    type="checkbox"
                                    checked={step.useMemory ?? false}
                                    onChange={(e) =>
                                      updateStep(step.id, {
                                        useMemory: e.target.checked,
                                      })
                                    }
                                  />
                                </div>
                                {step.useMemory && (
                                  <div className="mt-3">
                                    <Label>Memory Top K</Label>
                                    <Input
                                      type="number"
                                      className="mt-1.5"
                                      value={step.memoryTopK ?? 5}
                                      onChange={(e) =>
                                        updateStep(step.id, {
                                          memoryTopK: Number(e.target.value),
                                        })
                                      }
                                    />
                                  </div>
                                )}
                              </div>
                            </>
                          )}

                          {step.type === "HTTP" && (
                            <>
                              <div>
                                <Label>Method</Label>
                                <Select
                                  value={step.method}
                                  onValueChange={(v) =>
                                    updateStep(step.id, {
                                      method: v as any,
                                    })
                                  }
                                >
                                  <SelectTrigger className="mt-1.5">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="GET">GET</SelectItem>
                                    <SelectItem value="POST">POST</SelectItem>
                                    <SelectItem value="PUT">PUT</SelectItem>
                                    <SelectItem value="DELETE">DELETE</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label>URL</Label>
                                <Input
                                  className="mt-1.5"
                                  value={step.url ?? ""}
                                  onChange={(e) =>
                                    updateStep(step.id, {
                                      url: e.target.value,
                                    })
                                  }
                                />
                              </div>
                              <div>
                                <Label>Body (JSON)</Label>
                                <Textarea
                                  className="mt-1.5 min-h-[100px] font-mono text-sm"
                                  value={step.body ?? ""}
                                  onChange={(e) =>
                                    updateStep(step.id, {
                                      body: e.target.value,
                                    })
                                  }
                                />
                              </div>
                            </>
                          )}

                          {step.type === "Document" && (
                            <>
                              <div>
                                <Label>Document</Label>
                                <Select
                                  value={step.documentId}
                                  onValueChange={(v) =>
                                    updateStep(step.id, { documentId: v })
                                  }
                                >
                                  <SelectTrigger className="mt-1.5">
                                    <SelectValue placeholder="Select document" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {documents.map((doc) => (
                                      <SelectItem key={doc._id} value={doc._id}>
                                        {doc.title || "Untitled"}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label>Query</Label>
                                <Textarea
                                  className="mt-1.5 min-h-[100px]"
                                  value={step.query ?? ""}
                                  onChange={(e) =>
                                    updateStep(step.id, {
                                      query: e.target.value,
                                    })
                                  }
                                />
                              </div>
                              <div>
                                <Label>Top K Chunks</Label>
                                <Input
                                  type="number"
                                  className="mt-1.5"
                                  value={step.topK ?? 4}
                                  onChange={(e) =>
                                    updateStep(step.id, {
                                      topK: Number(e.target.value),
                                    })
                                  }
                                />
                              </div>
                            </>
                          )}

                          {step.type === "Delay" && (
                            <div>
                              <Label>Delay (seconds)</Label>
                              <Input
                                type="number"
                                className="mt-1.5"
                                value={step.delay ?? 0}
                                onChange={(e) =>
                                  updateStep(step.id, {
                                    delay: Number(e.target.value),
                                  })
                                }
                              />
                            </div>
                          )}

                            {/* GitHub */}
                          {step.type === "GitHub" && (
                            <>
                              <div>
                                <Label>Action</Label>
                                <Select
                                  value={step.action}
                                  onValueChange={(v) =>
                                    updateStep(step.id, { action: v })
                                  }
                                >
                                  <SelectTrigger className="mt-1.5">
                                    <SelectValue placeholder="Select action" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="create_issue">Create Issue</SelectItem>
                                    <SelectItem value="get_issue">Get Issue</SelectItem>
                                    <SelectItem value="comment_issue">Comment Issue</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label>Owner</Label>
                                <Input
                                  className="mt-1.5"
                                  value={(step as any).owner ?? ""}
                                  onChange={(e) =>
                                    updateStep(step.id, { owner: e.target.value } as any)
                                  }
                                />
                              </div>
                              <div>
                                <Label>Repo</Label>
                                <Input
                                  className="mt-1.5"
                                  value={(step as any).repo ?? ""}
                                  onChange={(e) =>
                                    updateStep(step.id, { repo: e.target.value } as any)
                                  }
                                />
                              </div>
                              {step.action === "create_issue" && (
                                <>
                                  <div>
                                    <Label>Title</Label>
                                    <Input
                                      className="mt-1.5"
                                      value={(step as any).title ?? ""}
                                      onChange={(e) =>
                                        updateStep(step.id, { title: e.target.value } as any)
                                      }
                                    />
                                  </div>
                                  <div>
                                    <Label>Body</Label>
                                    <Textarea
                                      className="mt-1.5"
                                      value={step.body ?? ""}
                                      onChange={(e) =>
                                        updateStep(step.id, { body: e.target.value })
                                      }
                                    />
                                  </div>
                                </>
                              )}
                              {(step.action === "get_issue" || step.action === "comment_issue") && (
                                <div>
                                  <Label>Issue Number</Label>
                                  <Input
                                    className="mt-1.5"
                                    value={(step as any).issue_number ?? ""}
                                    onChange={(e) =>
                                      updateStep(step.id, { issue_number: e.target.value } as any)
                                    }
                                  />
                                </div>
                              )}
                              {step.action === "comment_issue" && (
                                <div>
                                  <Label>Comment</Label>
                                  <Textarea
                                    className="mt-1.5"
                                    value={(step as any).comment ?? ""}
                                    onChange={(e) =>
                                      updateStep(step.id, { comment: e.target.value } as any)
                                    }
                                  />
                                </div>
                              )}
                            </>
                          )}

                              {/* Slack */}
                          {step.type === "Slack" && (
                            <div>
                              <Label>Message</Label>
                              <Textarea
                                className="mt-1.5"
                                value={step.text ?? ""}
                                onChange={(e) =>
                                  updateStep(step.id, { text: e.target.value })
                                }
                              />
                            </div>
                          )}
                              {/* Discord */}
                          {step.type === "Discord" && (
                            <div>
                              <Label>Message</Label>
                              <Textarea
                                className="mt-1.5"
                                value={step.content ?? ""}
                                onChange={(e) =>
                                  updateStep(step.id, { content: e.target.value })
                                }
                              />
                            </div>
                          )}

                          {/* CONDITION */}
                          {step.type === "Condition" && (
                            <>
                              <div>
                                <Label>Condition Type</Label>
                                <Select
                                  value={step.conditionType}
                                  onValueChange={(v) =>
                                    updateStep(step.id, {
                                      conditionType: v as any,
                                    })
                                  }
                                >
                                  <SelectTrigger className="mt-1.5">
                                    <SelectValue placeholder="Select type" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="boolean">Boolean</SelectItem>
                                    <SelectItem value="sentiment">Sentiment</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label>Operator</Label>
                                <Select
                                  value={step.operator}
                                  onValueChange={(v) =>
                                    updateStep(step.id, { operator: v as any })
                                  }
                                >
                                  <SelectTrigger className="mt-1.5">
                                    <SelectValue placeholder="Select operator" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {step.conditionType === "boolean" && (
                                      <>
                                        <SelectItem value="isTrue">is True</SelectItem>
                                        <SelectItem value="isFalse">is False</SelectItem>
                                      </>
                                    )}
                                    {step.conditionType === "sentiment" && (
                                      <>
                                        <SelectItem value="isPositive">is Positive</SelectItem>
                                        <SelectItem value="isNegative">is Negative</SelectItem>
                                      </>
                                    )}
                                  </SelectContent>
                                </Select>
                              </div>
                            </>
                          )}
                        </div>
                      </Card>
                    </motion.div>
                  ))}
                </AnimatePresence>

                <Button
                  variant="outline"
                  className="w-full bg-transparent"
                  onClick={addStep}
                >
                  <Plus className="mr-2 size-4" />
                  Add Step
                </Button>
              </div>
            )}
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
