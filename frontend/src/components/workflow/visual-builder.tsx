"use client";

import ReactFlow, {
  Controls,
  Background,
  addEdge,
  useNodesState,
  useEdgesState,
  Connection,
  Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import { v4 as uuidv4 } from "uuid";
import { Edge, applyNodeChanges, applyEdgeChanges } from "reactflow";
import { X } from "lucide-react";

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
  

type StepNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: React.ReactElement;
  };
  style?: React.CSSProperties;
};

type CustomEdge = Edge & {
  condition?: "true" | "false";
  caseValue?: string;
};

const EDGE_STYLE = { strokeWidth: 2 };

/* ---------- NODE COLORS ---------- */

function getNodeColor(type: string) {
  switch (type) {
    case "LLM":
      return "#7c3aed"; // purple
    case "HTTP":
      return "#2563eb"; // blue
    case "Tool":
      return "#f59e0b"; // orange
    case "Document":
      return "#16a34a"; // green
    case "Delay":
      return "#6b7280"; // gray
    default:
      return "#374151";
  }
}

function buildNodePreview(step: any, edges: CustomEdge[], allSteps: any[]) {
  const rows: { name: string; type: string }[] = [];

  if (step.type === "LLM") {
    rows.push({ name: "prompt", type: "string" });

    if (step.useMemory) {
      rows.push({ name: "memory", type: "agent" });
      rows.push({ name: "memoryTopK", type: "number" });
    }

    rows.push({ name: "output", type: "text" });
  }

  if (step.type === "HTTP") {
    rows.push({ name: "url", type: "string" });
    rows.push({ name: "method", type: "string" });
    rows.push({ name: "response", type: "json" });
  }

  if (step.type === "Delay") {
    rows.push({ name: "seconds", type: "number" });
  }

  if (step.type === "Tool") {
    rows.push({ name: "tool", type: "string" });
  }

  if (step.type === "Document") {
    rows.push({ name: "query", type: "string" });
    rows.push({ name: "topK", type: "number" });
  }

  if (step.type === "Condition") {
    const trueEdge = (edges as CustomEdge[]).find(
      (e) => e.source === step.id && e.condition === "true",
    );

    const falseEdge = (edges as CustomEdge[]).find(
      (e) => e.source === step.id && e.condition === "false",
    );

    const trueStep = allSteps.find((s) => s.id === trueEdge?.target);
    const falseStep = allSteps.find((s) => s.id === falseEdge?.target);

    rows.push({ name: "true ->", type: trueStep?.name || "?" });
    rows.push({ name: "false ->", type: falseStep?.name || "?" });
  }

  if (step.type === "Switch") {
    const outgoing = (edges as CustomEdge[]).filter(
      (e) => e.source === step.id,
    );

    outgoing.forEach((edge) => {
      const e = edge as CustomEdge;

      const targetStep = allSteps.find((s) => s.id === e.target);

      rows.push({
        name: e.caseValue || "case",
        type: targetStep?.name || "?",
      });
    });
  }

  return rows;
}

function computeNodes(
  steps: any[],
  flowEdges: CustomEdge[],
  onDeleteNode: (id: string) => void,
): StepNode[] {
  if (!steps?.length) return [];

  return steps.map((step, index) => {
    const schema = buildNodePreview(step, flowEdges, steps);

    return {
      id: step.id,
      type: "default",
      position: step.position || { x: index * 320, y: 120 },
      data: {
        label: (
          <div className="w-full text-sm">
            <div className="flex items-center justify-between border-b pb-1 mb-2 group">
              <span className="font-semibold truncate flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: getNodeColor(step.type) }}
                />
                {step.name || "Untitled Step"}
              </span>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteNode(step.id);
                }}
                className="text-red-500 hover:text-red-600 text-xs opacity-0 group-hover:opacity-100 transition"
              >
                x
              </button>
            </div>

            <div className="text-xs text-muted-foreground mb-2">
              {step.type}
            </div>

            <div className="space-y-1">
              {schema.map((row) => (
                <div
                  key={row.name}
                  className="flex justify-between gap-3 text-xs py-1 border-b border-muted/50 last:border-0"
                >
                  <span className="truncate">{row.name}</span>
                  <span className="text-muted-foreground truncate">
                    {row.type}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ),
      },
      style: {
        padding: "12px 16px",
        borderRadius: "12px",
        border: `1px solid ${getNodeColor(step.type)}`,
        background: "var(--card)",
        color: "var(--foreground)",
        fontSize: "14px",
        cursor: "pointer",
        fontWeight: 500,
        minWidth: 240,
        maxWidth: 240,
        textAlign: "center" as const,
        boxShadow: `0 0 0 1px ${getNodeColor(step.type)}20, 0 2px 6px rgba(0,0,0,0.05)`,
      },
    };
  });
}

export default function VisualBuilder({
  steps,
  setSteps,
  edges,
  onEdgesChange,
}: {
  steps: any[];
  setSteps: React.Dispatch<React.SetStateAction<any[]>>;
  edges: any[];
  onEdgesChange: (edges: any[]) => void;
}) {
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [documents, setDocuments] = useState<any[]>([]);
  const [flowEdges, setFlowEdges] = useState<CustomEdge[]>(() => edges || []);
  const selectedStep = steps.find((s) => s.id === selectedNode?.id);

  useEffect(() => {
    onEdgesChange(flowEdges);
  }, [flowEdges, onEdgesChange]);

  const deleteNode = useCallback(
    (nodeId: string) => {
      setFlowEdges((eds) =>
        eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );

      setSteps((prev) => prev.filter((s) => s.id !== nodeId));

      setSelectedNode((prev) => (prev?.id === nodeId ? null : prev));
    },
    [setSteps],
  );

  const [computedNodes, setComputedNodes] = useState(() =>
    computeNodes(steps, flowEdges, deleteNode),
  );

  useEffect(() => {
    setComputedNodes(computeNodes(steps, flowEdges, deleteNode));
  }, [steps, flowEdges, deleteNode]);

  const [nodes, setNodes, _onNodesChange] = useNodesState(computedNodes);

  useEffect(() => {
    setNodes((nds) =>
      computedNodes.map((newNode) => {
        const old = nds.find((n) => n.id === newNode.id);
        return old ? { ...old, ...newNode } : newNode;
      }),
    );
  }, [computedNodes, setNodes]);

  /* ---------- EVENTS ---------- */

  function onNodeClick(_: any, node: Node) {
    setSelectedNode(node);
  }

  function handleEdgesDelete(deletedEdges: any[]) {
    setFlowEdges((eds) =>
      eds.filter((edge) => !deletedEdges.some((d) => d.id === edge.id)),
    );
  }

  const onNodesChange = (changes: any) => {
    setNodes((nds) => {
      const updated = applyNodeChanges(changes, nds);

      // 🔥 AFTER nodes update, sync steps OUTSIDE render
      setTimeout(() => {
        setSteps((prev) =>
          prev.map((step) => {
            const node = updated.find((n) => n.id === step.id);
            if (!node) return step;

            return {
              ...step,
              position: node.position,
            };
          }),
        );
      }, 0);

      return updated;
    });
  };

  const handleEdgesChange = (changes: any) => {
    const hasStructuralChange = changes.some(
      (c: any) => c.type !== "select" && c.type !== "reset",
    );

    if (!hasStructuralChange) return;

    setFlowEdges((eds) => {
      return applyEdgeChanges(changes, eds);
    });
  };

  function rebuildStepOrder(newEdges: any[]) {
    if (!newEdges.length) return;

    const map: any = {};

    newEdges.forEach((edge) => {
      map[edge.source] = edge.target;
    });

    const start = steps.find((s) => !newEdges.find((e) => e.target === s.id));

    if (!start) return;

    const ordered = [start];
    let current = start;

    while (map[current.id]) {
      const next = steps.find((s) => s.id === map[current.id]);
      if (!next) break;

      ordered.push(next);
      current = next;
    }

    setSteps(ordered);
  }

  const onConnect = (params: Connection) => {
    const sourceStep = steps.find((s) => s.id === params.source);

    const isCondition = sourceStep?.type === "Condition";
    const isSwitch = sourceStep?.type === "Switch";

    let condition: "true" | "false" | null = null;
    let caseValue: string | null = null;

    if (isCondition) {
      const userChoice = prompt("Enter edge type: true / false");

      if (userChoice !== "true" && userChoice !== "false") {
        alert("Invalid input");
        return;
      }

      condition = userChoice;
    }

    if (isSwitch) {
      const userInput = prompt("Enter case value");

      if (!userInput?.trim()) {
        alert("Case value required");
        return;
      }

      const value = userInput.trim();

      const alreadyExists = flowEdges.some(
        (e) => e.source === params.source && e.caseValue === value,
      );

      if (alreadyExists) {
        alert("Case already exists");
        return;
      }

      caseValue = value;
    }

    setFlowEdges((eds) => {
      let filtered = eds;

      if (isCondition && condition) {
        filtered = (eds as CustomEdge[]).filter(
          (e) => !(e.source === params.source && e.condition === condition),
        );
      }

      const newEdge = {
        id: uuidv4(),
        ...params,
        animated: true,
        style: EDGE_STYLE,
        label: caseValue || condition?.toUpperCase() || "",
        condition,
        caseValue,
      };

      const updated = addEdge(newEdge, filtered);

      return updated;
    });
  };

  function updateStep(stepId: string, patch: any) {
    setSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    );
  }

  

  function updateNodeLabel(stepId: string, name: string, type: string) {
    const step = steps.find((s) => s.id === stepId);
    if (!step) return;

    const schema = buildNodePreview({ ...step, name, type }, flowEdges, steps);

    setNodes((nds) =>
      nds.map((n) =>
        n.id === stepId
          ? {
              ...n,
              data: {
                ...n.data,
                label: (
                  <div className="w-full text-sm">
                    {/* HEADER */}
                    <div className="flex items-center justify-between border-b pb-1 mb-2 group">
                      <span className="font-semibold truncate">{name}</span>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteNode(stepId);
                        }}
                        className="text-red-500 hover:text-red-600 text-xs opacity-0 group-hover:opacity-100 transition"
                      >
                        ✕
                      </button>
                    </div>

                    {/* TYPE */}
                    <div className="text-xs text-muted-foreground mb-2">
                      {type}
                    </div>

                    {/* SCHEMA */}
                    <div className="space-y-1">
                      {schema.map((row) => (
                        <div
                          key={row.name}
                          className="flex justify-between text-xs py-1 border-b border-muted/50 last:border-0"
                        >
                          <span>{row.name}</span>
                          <span className="text-muted-foreground">
                            {row.type}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ),
              },
            }
          : n,
      ),
    );
  }

  useEffect(() => {
    async function fetchDocuments() {
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
        console.error("Failed to load documents", err);
      }
    }

    fetchDocuments();
  }, []);

  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
        const step = steps.find((s) => s.id === node.id);
        if (!step) return node;

        const isSelected = selectedNode?.id === node.id;

        const border = isSelected
          ? "2px solid #3b82f6"
          : `1px solid ${getNodeColor(step.type)}`;

        const boxShadow = isSelected
          ? "0 0 0 2px rgba(59,130,246,.35), 0 4px 12px rgba(0,0,0,.25)"
          : `0 0 0 1px ${getNodeColor(step.type)}20, 0 2px 6px rgba(0,0,0,0.05)`;

        // ✅ prevent unnecessary re-renders
        if (
          node.style?.border === border &&
          node.style?.boxShadow === boxShadow
        ) {
          return node;
        }

        return {
          ...node,
          style: {
            ...node.style,
            border,
            boxShadow,
          },
          // ❌ DO NOT rebuild label here
        };
      }),
    );
  }, [selectedNode]);

  /* ---------- ADD NODE ---------- */

  function addNode() {
    const id = uuidv4();

    const node: StepNode = {
      id,
      type: "default",
      position: {
        x: Math.random() * 400,
        y: Math.random() * 400,
      },
      data: {
        label: (
          <div className="flex items-center justify-between gap-2">
            <span>New Step (LLM)</span>

            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteNode(id);
              }}
              className="text-red-500 hover:text-red-600 text-xs"
            >
              ✕
            </button>
          </div>
        ),
      },
      style: {
        padding: "12px 16px",
        borderRadius: "12px",
        border: `1px solid ${getNodeColor("LLM")}`,
        background: "var(--card)",
        color: "var(--foreground)",
        fontSize: "14px",
        fontWeight: 500,
        minWidth: 240,
        cursor: "pointer",
        maxWidth: 240,
        textAlign: "center" as const,
        boxShadow: `0 0 0 1px ${getNodeColor("LLM")}20, 0 2px 6px rgba(0,0,0,0.05)`,
      },
    };

    setNodes((n) => [...n, node]);

    setSteps([
      ...steps,
      {
        id,
        name: "New Step",
        type: "LLM",
        prompt: "",
      },
    ]);
  }

  return (
    <div className="h-[720px] rounded-xl border bg-gradient-to-b from-background to-muted/40 relative overflow-hidden">
      {/* ---------- ADD STEP BUTTON ---------- */}

      <div className="absolute z-20 top-4 left-4">
        <button
          onClick={addNode}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg shadow-md hover:scale-[1.02] hover:shadow-lg transition"
        >
          + Add Step
        </button>
      </div>

      {/* ---------- GRAPH ---------- */}

      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onConnect={onConnect}
        onNodesChange={onNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgesDelete={handleEdgesDelete}
        onNodeClick={onNodeClick}
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{ strokeWidth: 2 }}
        defaultEdgeOptions={{
          type: "default",
          animated: true,
          labelStyle: {
            fill: "var(--foreground)",
            fontSize: 12,
            fontWeight: 500,
          },
          labelBgStyle: {
            fill: "var(--card)",
            fillOpacity: 0.9,
          },
          labelBgPadding: [4, 2],
          labelBgBorderRadius: 4,
          style: { strokeWidth: 2 },
        }}
        fitView
        snapToGrid
        snapGrid={[20, 20]}
      >
        <Controls className="bg-card border rounded-md shadow" />

        <Background gap={24} size={1} />
      </ReactFlow>

      {/* ---------- SETTINGS PANEL ---------- */}

      {selectedNode && selectedStep && (
        <div className="absolute right-0 top-0 h-full w-[380px] bg-card border-l shadow-xl z-30 flex flex-col">
          {/* HEADER */}

          <div className="p-4 border-b flex items-start justify-between">
            <div>
              <h3 className="font-semibold text-lg">Step Settings</h3>
              <p className="text-xs text-muted-foreground">
                Configure workflow step
              </p>
            </div>

            <button
              onClick={() => setSelectedNode(null)}
              className="p-2 rounded-md hover:bg-muted transition"
            >
              <X size={18} />
            </button>
          </div>

          {/* FORM */}

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* STEP NAME */}

            <div>
              <label className="text-xs text-muted-foreground">Step Name</label>

              <input
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                value={selectedStep.name || ""}
                onChange={(e) => {
                  updateStep(selectedStep.id, { name: e.target.value });
                  updateNodeLabel(
                    selectedStep.id,
                    e.target.value,
                    selectedStep.type,
                  );
                }}
              />
            </div>

            {/* STEP TYPE */}

            <div>
              <label className="text-xs text-muted-foreground">Step Type</label>

              <select
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                value={selectedStep.type || ""}
                onChange={(e) => {
                  const type = e.target.value as StepType;

                  updateStep(selectedStep.id, { type });

                  updateNodeLabel(selectedStep.id, selectedStep.name, type);
                }}
              >
                <option value="" disabled>
                  Select step type
                </option>

                <option value="LLM">LLM</option>
                <option value="HTTP">HTTP</option>
                <option value="Delay">Delay</option>
                <option value="Tool">Tool</option>
                <option value="Document">Document</option>
                <option value="Condition">Condition</option>
                <option value="Switch">Switch</option>
                <option value="GitHub">GitHub</option>
                <option value="Slack">Slack</option>
                <option value="Discord">Discord</option>
              </select>
            </div>

            {/* ---------- LLM ---------- */}

            {selectedStep.type === "LLM" && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">
                    Prompt
                  </label>

                  <textarea
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background min-h-[120px]"
                    value={selectedStep.prompt || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { prompt: e.target.value })
                    }
                  />
                </div>

                {/* 🔥 Advanced Options */}
                <div className="rounded-lg border border-muted p-4">
                  <p className="text-sm font-semibold mb-3">Advanced Options</p>

                  <div className="flex items-center justify-between">
                    <label className="text-sm cursor-pointer">
                      Use Agent Memory
                    </label>

                    <input
                      type="checkbox"
                      checked={selectedStep.useMemory ?? false}
                      onChange={(e) =>
                        updateStep(selectedStep.id, {
                          useMemory: e.target.checked,
                        })
                      }
                    />
                  </div>

                  {selectedStep.useMemory && (
                    <div className="mt-3">
                      <label className="text-sm">Memory Top K</label>

                      <input
                        type="number"
                        className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                        value={selectedStep.memoryTopK ?? 5}
                        onChange={(e) =>
                          updateStep(selectedStep.id, {
                            memoryTopK: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ---------- DELAY ---------- */}

            {selectedStep.type === "Delay" && (
              <div>
                <label className="text-xs text-muted-foreground">
                  Delay (seconds)
                </label>

                <input
                  type="number"
                  className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                  value={selectedStep.delay || ""}
                  onChange={(e) =>
                    updateStep(selectedStep.id, {
                      delay: Number(e.target.value),
                    })
                  }
                />
              </div>
            )}

            {/* ---------- HTTP ---------- */}

            {selectedStep.type === "HTTP" && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">URL</label>

                  <input
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.url || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { url: e.target.value })
                    }
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground">
                    Method
                  </label>

                  <select
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.method || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { method: e.target.value })
                    }
                  >
                    <option value="" disabled>
                      Select method
                    </option>

                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                </div>
              </>
            )}

            {/* ---------- TOOL ---------- */}

            {selectedStep.type === "Tool" && (
              <div>
                <label className="text-xs text-muted-foreground">Tool</label>

                <select
                  className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                  value={selectedStep.tool || ""}
                  onChange={(e) =>
                    updateStep(selectedStep.id, { tool: e.target.value })
                  }
                >
                  <option value="" disabled>
                    Select tool
                  </option>

                  <option value="email">Email</option>
                  <option value="file">File</option>
                  <option value="browser">Browser</option>
                </select>
              </div>
            )}

            {/* EMAIL */}

            {selectedStep.type === "Tool" && selectedStep.tool === "email" && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">To</label>

                  <input
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.to || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { to: e.target.value })
                    }
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground">
                    Subject
                  </label>

                  <input
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.subject || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { subject: e.target.value })
                    }
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground">Text</label>

                  <textarea
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.text || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { text: e.target.value })
                    }
                  />
                </div>
              </>
            )}

            {/* FILE */}

            {selectedStep.type === "Tool" && selectedStep.tool === "file" && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">
                    Action
                  </label>

                  <select
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.action || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { action: e.target.value })
                    }
                  >
                    <option value="" disabled>
                      Select action
                    </option>

                    <option value="write">Write</option>
                    <option value="append">Append</option>
                    <option value="read">Read</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground">Path</label>

                  <input
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.path || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, { path: e.target.value })
                    }
                  />
                </div>

                {selectedStep.action !== "read" && (
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Content
                    </label>

                    <textarea
                      className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                      value={selectedStep.content || ""}
                      onChange={(e) =>
                        updateStep(selectedStep.id, {
                          content: e.target.value,
                        })
                      }
                    />
                  </div>
                )}
              </>
            )}

            {/* BROWSER */}

            {selectedStep.type === "Tool" &&
              selectedStep.tool === "browser" && (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Action
                    </label>

                    <select
                      className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                      value={selectedStep.action || ""}
                      onChange={(e) =>
                        updateStep(selectedStep.id, { action: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Select action
                      </option>

                      <option value="screenshot">Screenshot</option>
                      <option value="evaluate">Evaluate</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">URL</label>

                    <input
                      className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                      value={selectedStep.url || ""}
                      onChange={(e) =>
                        updateStep(selectedStep.id, { url: e.target.value })
                      }
                    />
                  </div>

                  {selectedStep.action === "evaluate" && (
                    <div>
                      <label className="text-xs text-muted-foreground">
                        Code
                      </label>

                      <textarea
                        className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                        value={selectedStep.code || ""}
                        onChange={(e) =>
                          updateStep(selectedStep.id, { code: e.target.value })
                        }
                      />
                    </div>
                  )}
                </>
              )}

            {/* DOCUMENT */}

            {selectedStep.type === "Document" && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">
                    Document
                  </label>

                  <select
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.documentId || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, {
                        documentId: e.target.value,
                      })
                    }
                  >
                    <option value="" disabled>
                      Select document
                    </option>

                    {documents.map((doc) => (
                      <option key={doc._id} value={doc._id}>
                        {doc.title || "Untitled Document"}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground">Query</label>

                  <textarea
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.query || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, {
                        query: e.target.value,
                      })
                    }
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground">Top K</label>

                  <input
                    type="number"
                    className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 mt-1 bg-background"
                    value={selectedStep.topK || 4}
                    onChange={(e) =>
                      updateStep(selectedStep.id, {
                        topK: Number(e.target.value),
                      })
                    }
                  />
                </div>
              </>
            )}

                {/* GitHub */}
            {selectedStep.type === "GitHub" && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">Action</label>
                  <select
                    className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                    value={selectedStep.action || ""}
                    onChange={(e) => {
                      updateStep(selectedStep.id, { action: e.target.value });
                    }}
                  >
                    <option value="" disabled>Select action</option>
                    <option value="create_issue">Create Issue</option>
                    <option value="get_issue">Get Issue</option>
                    <option value="comment_issue">Comment Issue</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Owner</label>
                  <input
                    className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                    value={selectedStep.owner || ""}
                    onChange={(e) => updateStep(selectedStep.id, {owner: e.target.value})}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Repo</label>
                  <input
                    className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                    value={selectedStep.repo || ""}
                    onChange={(e) => updateStep(selectedStep.id, {repo: e.target.value})}
                  />
                </div>
                {selectedStep.action === "create_issue" && (
                  <>
                    <div>
                      <label className="text-xs text-muted-foreground">Title</label>
                      <input
                        className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                        value={selectedStep.title || ""}
                        onChange={(e) => updateStep(selectedStep.id, {title: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Body</label>
                      <textarea
                        className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                        value={selectedStep.body || ""}
                        onChange={(e) => updateStep(selectedStep.id, {body: e.target.value})}
                      />
                    </div>
                  </>
                )}
                {(selectedStep.action === "get_issue" || selectedStep.action === "comment_issue") && (
                  <div>
                    <label className="text-xs text-muted-foreground">Issue Number</label>
                    <input
                      className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                      value={selectedStep.issue_number || ""}
                      onChange={(e) => updateStep(selectedStep.id, {issue_number: e.target.value})}
                    />
                  </div>
                )}
                {selectedStep.action === "comment_issue" && (
                  <div>
                    <label className="text-xs text-muted-foreground">Comment</label>
                    <textarea
                      className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                      value={selectedStep.comment || ""}
                      onChange={(e) => updateStep(selectedStep.id, {comment: e.target.value})}
                    />
                  </div>
                )}
              </>
            )}

            {/* Slack */}
            {selectedStep.type === "Slack" && (
              <div>
                <label className="text-xs text-muted-foreground">Message</label>
                <textarea
                  className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                  value={selectedStep.text || ""}
                  onChange={(e) => updateStep(selectedStep.id, {text: e.target.value})}
                />
              </div>
            )}

            {/* Discord */}
            {selectedStep.type === "Discord" && (
              <div>
                <label className="text-xs text-muted-foreground">Message</label>
                <textarea
                  className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                  value={selectedStep.content || ""}
                  onChange={(e) => updateStep(selectedStep.id, {content: e.target.value})}
                />
              </div>
            )}

            {/* CONDITION */}
            {selectedStep.type === "Condition" && (
              <>
                {/* CONDITION TYPE */}
                <div>
                  <label className="text-xs text-muted-foreground">
                    Condition Type
                  </label>

                  <select
                    className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                    value={selectedStep.conditionType || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, {
                        conditionType: e.target.value,
                      })
                    }
                  >
                    <option value="">Select operator</option>
                    <option value="boolean">Boolean (Yes/No)</option>
                    <option value="sentiment">Sentiment</option>
                    <option value="contains">Contains Text</option>
                  </select>
                </div>

                {/* OPERATOR */}
                <div>
                  <label className="text-xs text-muted-foreground">
                    Operator
                  </label>

                  <select
                    className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                    value={selectedStep.operator || ""}
                    onChange={(e) =>
                      updateStep(selectedStep.id, {
                        operator: e.target.value,
                      })
                    }
                  >
                    <option value="">Select operator</option>

                    {selectedStep.conditionType === "boolean" && (
                      <>
                        <option value="isTrue">Is True</option>
                        <option value="isFalse">Is False</option>
                      </>
                    )}

                    {selectedStep.conditionType === "sentiment" && (
                      <>
                        <option value="isPositive">Positive</option>
                        <option value="isNegative">Negative</option>
                      </>
                    )}

                    {selectedStep.conditionType === "contains" && (
                      <>
                        <option value="includes">Includes</option>
                        <option value="notIncludes">Does Not Include</option>
                      </>
                    )}
                  </select>
                </div>

                {/* VALUE (ONLY FOR CONTAINS) */}
                {selectedStep.conditionType === "contains" && (
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Value
                    </label>

                    <input
                      className="w-full border rounded-lg px-3 py-2 mt-1 bg-background"
                      value={selectedStep.value || ""}
                      onChange={(e) =>
                        updateStep(selectedStep.id, {
                          value: e.target.value,
                        })
                      }
                    />
                  </div>
                )}
              </>
            )}

            {/* SWITCH */}
            {selectedStep.type === "Switch" && (
              <>
                <div className="text-xs text-muted-foreground">
                  Connect edges to define cases.
                </div>

                <div className="text-xs opacity-70">
                  Each connection = one case value
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
