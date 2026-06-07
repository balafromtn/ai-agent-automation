const { writeLog } = require("./logger");
const mongoose = require("mongoose");
const Task = require("../models/task.model");
const Workflow = require("../models/workflow.model");
const SystemSettings = require("../models/systemSettings.model");
const { claimNextTask, completeTask } = require("./queueService");
const { executeStep } = require("./executor");
const telemetryService = require("../services/telemetry.service");
const WORKER_ID = process.env.WORKER_ID || "agent-1";
require("dotenv").config();

/* -------------------------
   Settings cache
------------------------- */
let cachedWorkerSettings = null;
let lastSettingsFetch = 0;
const SETTINGS_REFRESH_MS = 5000;

/* -------------------------
   Safety fallback (only if DB fails)
------------------------- */
const SAFE_FALLBACK_SETTINGS = {
  pollIntervalMs: 2000,
  maxAttempts: 3,
};

/* -------------------------
   Utils
------------------------- */
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function getGlobalWorkerSettings() {
  const now = Date.now();

  if (
    cachedWorkerSettings &&
    now - lastSettingsFetch < SETTINGS_REFRESH_MS
  ) {
    return cachedWorkerSettings;
  }

  try {
    const settings = await SystemSettings.findOne().lean();

    cachedWorkerSettings = settings?.worker || SAFE_FALLBACK_SETTINGS;
    lastSettingsFetch = now;

    // console.log("🔁 Worker settings loaded:", cachedWorkerSettings);
    return cachedWorkerSettings;
  } catch (err) {
    console.error("⚠️ Failed to load worker settings:", err.message);
    return SAFE_FALLBACK_SETTINGS;
  }
}

/* -------------------------
   Worker loop
------------------------- */
let isRunningLoop = false;
let activeThreadsCount = 0;
let isPolling = false;

async function executeSingleTask(task) {
  try {
    console.log(`📝 Task claimed: ${task._id}`);
    writeLog("Task claimed", "info", {
      workerId: WORKER_ID,
      taskId: task._id,
      workflowId: task.workflowId,
    });

    const workflow = task.workflowId
      ? await Workflow.findById(task.workflowId).lean()
      : null;

    let agent = null;

    if (workflow?.agentId) {
      const Agent = require("../models/agent.model");
      agent = await Agent.findById(workflow.agentId).lean();
    }

    const now = new Date();
    const context = {
      ...(task.input || {}),
      timestampIso: now.toISOString(),
      timestamp: now.toLocaleString("en-US", {
        dateStyle: "long",
        timeStyle: "short",
      }),
      date: now.toLocaleDateString("en-US", { dateStyle: "long" }),
      time: now.toLocaleTimeString("en-US", { timeStyle: "short" }),
      workflow,
      taskId: task._id,
      userId: task.userId,
      results: [],
    };

    // -------------------------
    // Resolve steps
    // -------------------------
    const steps =
      Array.isArray(task.steps) && task.steps.length > 0
        ? task.steps
        : Array.isArray(task.metadata?.steps) && task.metadata.steps.length > 0
          ? task.metadata.steps
          : Array.isArray(workflow?.metadata?.steps)
            ? workflow.metadata.steps
            : [];

    const edges =
      Array.isArray(task.metadata?.edges) && task.metadata.edges.length > 0
        ? task.metadata.edges
        : Array.isArray(workflow?.metadata?.edges)
          ? workflow.metadata.edges
          : [];
    let success = true;

    if (steps.length > 0) {
      console.log(`⚙️ Executing ${steps.length} steps…`);
      writeLog(`Executing ${steps.length} steps`, "info", {
        workerId: WORKER_ID,
        taskId: task._id,
        workflowId: task.workflowId,
      });

      function getStepId(step) {
        return step.stepId || step.id || step.name;
      }

      const stepsMap = {};
      steps.forEach((s) => {
        stepsMap[getStepId(s)] = s;
      });

      // find start node (no incoming edges)
      const targetSet = new Set(edges.map((e) => e.target));
      let currentStep = steps.find((s) => !targetSet.has(getStepId(s)));

      let visited = new Set();

      let stepCount = 0;
      const MAX_STEPS = 50;

      while (currentStep && stepCount < MAX_STEPS) {
        stepCount++;
        if (stepCount >= MAX_STEPS) {
          console.warn("⚠️ Max steps reached, stopping execution");
          success = false;
        }

        visited.add(getStepId(currentStep));

        const result = await executeStep(currentStep, context, agent);

        // attach debug info directly to result
        result.name = currentStep.name;
        result.type = currentStep.type;

        await Task.findByIdAndUpdate(task._id, {
          $push: { stepResults: result },
        });

        context.results.push(result);
        context.last = {
          input: result.input,
          output: result.output,
        };

        if (!result.success) {
          success = false;
          break;
        }

        // FIND NEXT STEP USING EDGES
        let nextEdge = null;

        // CONDITION
        if (currentStep.type === "condition") {
          const branch = result.branch;

          nextEdge = edges.find(
            (e) =>
              e.source === getStepId(currentStep) &&
              e.condition === branch
          );
        }

        // SWITCH
        else if (currentStep.type === "switch") {
          const normalize = (v) =>
            String(v || "").toLowerCase().trim();

          const value = normalize(result.caseValue);

          nextEdge = edges.find((e) => {
            if (e.source !== getStepId(currentStep)) return false;

            const edgeValue = normalize(e.caseValue);

            return value.includes(edgeValue);
          });

          console.log("🔀 SWITCH DEBUG:", {
            resultValue: value,
            availableEdges: edges
              .filter(e => e.source === getStepId(currentStep))
              .map(e => e.caseValue)
          });

          // fallback (default edge)
          if (!nextEdge) {
            nextEdge = edges.find(
              (e) =>
                e.source === getStepId(currentStep) &&
                !e.caseValue
            );
          }
        }

        // DEFAULT (linear fallback)
        else {
          nextEdge = edges.find((e) => e.source === getStepId(currentStep));
        }

        if (!nextEdge) break;

        currentStep = stepsMap[nextEdge.target];
      }
    } else {
      const llmResult = await executeStep(
        {
          type: "llm",
          prompt: task.input?.text || "Give a short summary.",
        },
        context,
        agent
      );
      console.log("🧪 LLM RESULT:", llmResult);

      await Task.findByIdAndUpdate(task._id, {
        $push: { stepResults: llmResult },
      });

      success = llmResult.success;
      writeLog("Fallback LLM executed (no steps found)", "warn", {
        workerId: WORKER_ID,
        taskId: task._id,
        workflowId: task.workflowId,
      });
    }

    // -------------------------
    // Complete task
    // -------------------------
    await completeTask(task._id, { success });

    const durationMs = task.startedAt
      ? Date.now() - new Date(task.startedAt).getTime()
      : 0;

    const stepTypes = context.results.map((result) => result.type || "unknown");
    telemetryService
      .recordTaskMetrics({ stepTypes, durationMs })
      .catch((err) => {
        console.error("Telemetry recordTaskMetrics failed:", err.message || err);
      });

    console.log(`✅ Task ${task._id} completed. Success: ${success}`);
    writeLog(
      success
        ? "Task completed successfully"
        : "Task completed with failure",
      success ? "success" : "error",
      {
        workerId: WORKER_ID,
        taskId: task._id,
        workflowId: task.workflowId,
      }
    );

  } catch (error) {
    console.error("❌ Worker task error:", error);
    writeLog(`Task run error: ${error.message}`, "error", {
      workerId: WORKER_ID,
      taskId: task._id,
    });
    try {
      await completeTask(task._id, { success: false });
    } catch (e) {
      // ignore
    }
  }
}

async function pollAndProcessQueue() {
  const limit = Number(process.env.WORKER_CONCURRENCY_LIMIT || 5);

  if (activeThreadsCount >= limit) {
    return;
  }

  if (isPolling) {
    return;
  }
  isPolling = true;

  try {
    const task = await claimNextTask({ workerId: WORKER_ID });
    isPolling = false;

    if (!task) {
      if (activeThreadsCount === 0) {
        const { pollIntervalMs } = await getGlobalWorkerSettings();
        await sleep(pollIntervalMs);
        setImmediate(pollAndProcessQueue);
      }
      return;
    }

    activeThreadsCount++;

    executeSingleTask(task).finally(() => {
      activeThreadsCount--;
      setImmediate(pollAndProcessQueue);
    });

    if (activeThreadsCount < limit) {
      setImmediate(pollAndProcessQueue);
    }
  } catch (err) {
    isPolling = false;
    console.error("❌ Worker poll error:", err);
    const { pollIntervalMs } = await getGlobalWorkerSettings();
    await sleep(pollIntervalMs);
    setImmediate(pollAndProcessQueue);
  }
}

async function runWorkerLoop() {
  if (isRunningLoop) return;
  isRunningLoop = true;

  console.log("👷 Agent Runner Started… waiting for tasks");
  writeLog("Runner started", "info", { workerId: WORKER_ID });

  pollAndProcessQueue();
}

/* -------------------------
   Startup
------------------------- */
async function start() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("📡 MongoDB connected for Agent Runner");
  }
  runWorkerLoop();
}

module.exports = { start, runWorkerLoop };

if (require.main === module) {
  console.log("🚀 Starting Worker Service...");
  start();
}
