// backend/src/agents/executor.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { runLLM } = require("./llmAdapter");
const { runGitHub } = require("../integrations/github");
const { runSlack } = require("../integrations/slack");
const { runDiscord } = require("../integrations/discord");
const { invokeTool: invokeMcpTool } = require("../mcp/executionAdapter");
const { WorkflowContext, interpolate } = require('./contextManager');
require("dotenv").config();

function resolveWorkflowFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("Invalid file path");
  }

  if (filePath.includes("\0")) {
    throw new Error("Invalid file path");
  }

  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error("Invalid file path: absolute paths are not allowed");
  }

  const normalized = path.normalize(filePath);
  if (normalized.includes("..")) {
    throw new Error("Invalid file path: path traversal not allowed");
  }

  return normalized;
}

async function executeStep(step, context = {}, agent = null) {
  const start = Date.now();

  // Ensure context is WorkflowContext instance
  const ctx = context instanceof WorkflowContext ? context : new WorkflowContext(context);

  try {
    // ----- LLM -----
    if (step.type === "llm") {
      const prompt = interpolate(step.prompt, ctx);

      let finalPrompt = prompt;

      if (step.useMemory && agent) {
        const { retrieveMemory } = require("../services/memoryService");

        const memories = await retrieveMemory(agent, prompt, step.memoryTopK || 5);

        if (memories.length > 0) {
          const MAX_MEMORY_CHARS = 4000;

          let memoryText = memories
            .map((m, i) => {
              const parsed = JSON.parse(m.content);
              return `Memory ${i + 1}:\nUser: ${parsed.user}\nAssistant: ${parsed.assistant}`;
            })
            .join("\n\n");

          if (memoryText.length > MAX_MEMORY_CHARS) {
            memoryText = memoryText.slice(0, MAX_MEMORY_CHARS);
          }

          finalPrompt =
            `SYSTEM INSTRUCTION:
You are an AI agent with persistent memory.
The following MEMORY is factual and must be used when answering.

MEMORY:
${memoryText}

USER QUESTION:
${prompt}

Use the MEMORY section to answer the question.

If the answer appears in MEMORY, respond using it.

If MEMORY contains the project name or related information, return it clearly.
Do not say you lack memory.`;

          console.log("Retrieved memories:", memories.length);
        }
      }

      const llmRes = await runLLM(finalPrompt, {
        provider: agent?.config?.provider,
        model: agent?.config?.model,
        temperature: agent?.config?.temperature,
        ...step.options
      });

      const result = {
        stepId: step.stepId || null,
        type: "llm",
        tool: "llm",
        input: prompt,
        output: llmRes.text,
        raw: llmRes.raw,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: prompt,
        prompt: finalPrompt,
        output: llmRes.text,
        raw: llmRes.raw,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: prompt, output: llmRes.text };

      if (step.useMemory && agent && llmRes.text) {
        const { storeMemory } = require("../services/memoryService");

        await storeMemory(
          agent,
          JSON.stringify({
            user: prompt,
            assistant: llmRes.text
          }),
          {
            taskId: ctx.taskId,
            workflowId: ctx.workflow?._id,
            type: "conversation"
          }
        );
      }

      return result;
    }

    // ----- DELAY -----
    if (step.type === "delay") {
      const sec = Number(step.seconds ?? step.delay ?? step.prompt ?? 0);

      console.log("⏳ Delay step → sleeping for", sec, "seconds");

      await new Promise(resolve => setTimeout(resolve, sec * 1000));

      const result = {
        stepId: step.stepId,
        type: "delay",
        tool: "delay",
        input: sec,
        output: `Slept for ${sec} seconds`,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: sec,
        prompt: null,
        output: `Slept for ${sec} seconds`,
        raw: null,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: sec, output: `Slept for ${sec} seconds` };

      return result;
    }

    // ----- HTTP -----
    if (step.type === "http") {
      let parsedBody = null;

      if (step.body) {
        const interpolated = interpolate(step.body, ctx);
        try {
          parsedBody = JSON.parse(interpolated);
        } catch (err) {
          parsedBody = interpolated;
        }
      }

      const response = await axios({
        method: (step.method || "GET").toLowerCase(),
        url: interpolate(step.url || "", ctx),
        data: parsedBody,
        headers: step.headers || {},
        timeout: step.timeout || 30000,
        validateStatus: () => true,
      });

      const result = {
        stepId: step.stepId || null,
        type: "http",
        tool: "http",
        input: interpolate(step.url || "", ctx),
        output: response.data,
        success: response.status >= 200 && response.status < 300,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: interpolate(step.url || "", ctx),
        prompt: null,
        output: response.data,
        raw: response,
        success: response.status >= 200 && response.status < 300,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: interpolate(step.url || "", ctx), output: response.data };

      return result;
    }

    // ----- EMAIL -----
    if (step.type === "email") {
      try {
        const nodemailer = require("nodemailer");

        const transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: Number(process.env.EMAIL_PORT),
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        const to = interpolate(step.to || "", ctx);
        const subject = interpolate(step.subject || "", ctx);
        const text = interpolate(step.text || "", ctx);
        const html = interpolate(step.html || "", ctx);

        const info = await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
          to,
          subject,
          text,
          html,
        });

        const result = {
          stepId: step.stepId,
          type: "email",
          tool: "email",
          input: { to, subject, text, html },
          output: { messageId: info.messageId, accepted: info.accepted },
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { to, subject, text, html },
          prompt: null,
          output: { messageId: info.messageId, accepted: info.accepted },
          raw: info,
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { to, subject, text, html }, output: { messageId: info.messageId, accepted: info.accepted } };

        return result;
      } catch (err) {
        const result = {
          stepId: step.stepId,
          type: "email",
          tool: "email",
          input: null,
          output: err.message,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: null,
          prompt: null,
          output: err.message,
          raw: err,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: null, output: err.message };

        return result;
      }
    }

    // ----- FILE -----
    if (step.type === "file") {
      const action = (step.action || "read").toLowerCase();
      const resolvedPath = resolveWorkflowFilePath(
        step.path ? interpolate(step.path, ctx) : `runtime/stepName_${step.name}_TaskId_${ctx.taskId}.txt`
      );
      const content = interpolate(step.content || "", ctx);
      const { runToolInSandbox } = require("../tools/registry");

      try {
        let result;
        if (action === "write") {
          const res = await runToolInSandbox("fileTool", "write", [resolvedPath, content]);
          result = {
            stepId: step.stepId,
            type: "file",
            tool: "file",
            input: { action, path: resolvedPath, content },
            output: { path: res.path },
            success: true,
            timestamp: new Date(),
            duration: Date.now() - start,
          };
        } else if (action === "append") {
          const res = await runToolInSandbox("fileTool", "append", [resolvedPath, content]);
          result = {
            stepId: step.stepId,
            type: "file",
            tool: "file",
            input: { action, path: resolvedPath, content },
            output: { path: res.path },
            success: true,
            timestamp: new Date(),
            duration: Date.now() - start,
          };
        } else if (action === "read") {
          const res = await runToolInSandbox("fileTool", "read", [resolvedPath]);
          result = {
            stepId: step.stepId,
            type: "file",
            tool: "file",
            input: { action, path: resolvedPath },
            output: res,
            success: true,
            timestamp: new Date(),
            duration: Date.now() - start,
          };
        } else {
          result = {
            stepId: step.stepId,
            type: "file",
            tool: "file",
            input: { action },
            output: `Unknown file action: ${action}`,
            success: false,
            timestamp: new Date(),
            duration: Date.now() - start,
          };
        }

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: result.input,
          prompt: null,
          output: result.output,
          raw: null,
          success: result.success,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: result.input, output: result.output };

        return result;
      } catch (err) {
        const result = {
          stepId: step.stepId,
          type: "file",
          tool: "file",
          input: { action, path: resolvedPath },
          output: err.message,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action, path: resolvedPath },
          prompt: null,
          output: err.message,
          raw: err,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action, path: resolvedPath }, output: err.message };

        return result;
      }
    }

    // ----- BROWSER -----
    if (step.type === "browser") {
      const action = (step.action || "screenshot").toLowerCase();
      const url = interpolate(step.url || "", ctx);
      const { runToolInSandbox } = require("../tools/registry");

      try {
        let result;
        if (action === "screenshot") {
          const outPath = path.join("runtime", `screenshot_${ctx.taskId}_${Date.now()}.png`);
          const res = await runToolInSandbox("browserTool", "screenshot", [url, { path: outPath }]);
          result = {
            stepId: step.stepId,
            type: "browser",
            tool: "browser",
            input: { action, url },
            output: { path: res.path },
            success: true,
            timestamp: new Date(),
            duration: Date.now() - start,
          };
        } else if (action === "evaluate") {
          const userCode = step.code || "return document.title;";
          const res = await runToolInSandbox("browserTool", "evaluate", [url, userCode]);
          result = {
            stepId: step.stepId,
            type: "browser",
            tool: "browser",
            input: { action, url, code: userCode },
            output: res.result,
            success: !res.result?.error,
            timestamp: new Date(),
            duration: Date.now() - start,
          };
        } else {
          result = {
            stepId: step.stepId,
            type: "browser",
            tool: "browser",
            input: { action },
            output: `Unknown browser action: ${action}`,
            success: false,
            timestamp: new Date(),
            duration: Date.now() - start,
          };
        }

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: result.input,
          prompt: null,
          output: result.output,
          raw: null,
          success: result.success,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: result.input, output: result.output };

        return result;
      } catch (err) {
        const result = {
          stepId: step.stepId,
          type: "browser",
          tool: "browser",
          input: { action, url },
          output: err.message,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action, url },
          prompt: null,
          output: err.message,
          raw: err,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action, url }, output: err.message };

        return result;
      }
    }

    // ----- DOCUMENT QUERY -----
    if (step.type === "document_query") {
      const { queryDocument } = require("../services/documentService");
      const documentId = step.documentId;
      const query = interpolate(step.query || "", ctx);

      const chunks = await queryDocument(
        agent,
        ctx.userId,
        documentId,
        query,
        step.topK || 3
      );

      let contextText = chunks.map((c, i) => `Chunk ${i + 1}:\n${c.content}`).join("\n\n");

      const MAX_CONTEXT = 3000;
      if (contextText.length > MAX_CONTEXT) {
        contextText = contextText.slice(0, MAX_CONTEXT);
      }

      const finalPrompt = `
SYSTEM INSTRUCTION:
You are answering questions using retrieved document context.

Rules:
- Only use the provided document context.
- If the answer is not in the context, say "The document does not contain that information."
- Do not hallucinate.

DOCUMENT CONTEXT:
${contextText}

QUESTION:
${query}
`;

      const llmRes = await runLLM(finalPrompt, {
        provider: agent?.config?.provider,
        model: agent?.config?.model,
        temperature: agent?.config?.temperature
      });

      const result = {
        stepId: step.stepId,
        type: "document_query",
        tool: "document",
        input: query,
        output: llmRes.text,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: query,
        prompt: finalPrompt,
        output: llmRes.text,
        raw: llmRes.raw,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: query, output: llmRes.text };

      return result;
    }

    // ----- CONDITION -----
    if (step.type === "condition") {
      const normalize = (val) => {
        if (!val) return "";
        return String(val)
          .toLowerCase()
          .trim()
          .replace(/[\n\r]+/g, " ")
          .replace(/[^\w\s]/g, "")
          .replace(/\s+/g, " ");
      };

      const rawOutput = ctx.last?.output || "";
      const text = normalize(rawOutput);
      let evaluation = false;

      try {
        if (step.conditionType === "boolean") {
          const userQuery = ctx.results[0]?.input || "";
          const modelAnswer = ctx.last?.output || "";

          const prompt = `You are a strict boolean evaluator.\n\nQuestion:\n${userQuery}\n\nAnswer:\n${modelAnswer}\n\nDoes the answer mean TRUE or FALSE?\n\nRespond ONLY with:\ntrue\nor\nfalse`;

          const aiResult = await runLLM(prompt, {
            provider: agent?.config?.provider,
            model: agent?.config?.model,
            temperature: 0,
          });

          evaluation = aiResult.text.toLowerCase().trim().includes("true");
        } else if (step.conditionType === "sentiment") {
          let result = null;
          if (text.includes("positive")) result = true;
          else if (text.includes("negative")) result = false;

          if (result === null) {
            const classification = await runLLM(`Reply ONLY "positive" or "negative".\n\nText:\n${rawOutput}`, {
              provider: agent?.config?.provider,
              model: agent?.config?.model,
              temperature: 0,
            });
            result = normalize(classification.text).includes("positive");
          }

          evaluation = step.operator === "isPositive" ? result === true : result === false;
        }
      } catch (err) {
        console.log("❌ Condition error:", err);
        evaluation = false;
      }

      const result = {
        stepId: step.stepId,
        type: "condition",
        output: evaluation,
        branch: evaluation ? "true" : "false",
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: rawOutput,
        prompt: null,
        output: evaluation,
        raw: { evaluation, branch: evaluation ? "true" : "false" },
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: rawOutput, output: evaluation };

      return result;
    }

    // ----- SWITCH -----
    if (step.type === "switch") {
      const output = String(ctx.last?.output || "")
        .toLowerCase()
        .trim();

      console.log("🔀 SWITCH INPUT:", output);

      const result = {
        stepId: step.stepId,
        type: "switch",
        tool: "switch",
        input: output,
        output: output,
        caseValue: output,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: output,
        prompt: null,
        output: output,
        raw: { caseValue: output },
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: output, output: output };

      return result;
    }

    // ----- GITHUB -----
    if (step.type === "github") {
      try {
        const output = await runGitHub(step, ctx, interpolate);
        const result = {
          stepId: step.stepId || null,
          type: "github",
          tool: "github",
          input: { action: step.action },
          output,
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action: step.action },
          prompt: null,
          output,
          raw: null,
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action: step.action }, output };

        return result;
      } catch (err) {
        const result = {
          stepId: step.stepId || null,
          type: "github",
          tool: "github",
          input: { action: step.action },
          output: err.message,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action: step.action },
          prompt: null,
          output: err.message,
          raw: err,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action: step.action }, output: err.message };

        return result;
      }
    }

    // ----- SLACK -----
    if (step.type === "slack") {
      try {
        const output = await runSlack(step, ctx, interpolate);
        const result = {
          stepId: step.stepId || null,
          type: "slack",
          tool: "slack",
          input: { action: step.action },
          output,
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action: step.action },
          prompt: null,
          output,
          raw: null,
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action: step.action }, output };

        return result;
      } catch (err) {
        const result = {
          stepId: step.stepId || null,
          type: "slack",
          tool: "slack",
          input: { action: step.action },
          output: err.message,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action: step.action },
          prompt: null,
          output: err.message,
          raw: err,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action: step.action }, output: err.message };

        return result;
      }
    }

    // ----- DISCORD -----
    if (step.type === "discord") {
      try {
        const output = await runDiscord(step, ctx, interpolate);
        const result = {
          stepId: step.stepId || null,
          type: "discord",
          tool: "discord",
          input: { action: step.action },
          output,
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action: step.action },
          prompt: null,
          output,
          raw: null,
          success: true,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action: step.action }, output };

        return result;
      } catch (err) {
        const result = {
          stepId: step.stepId || null,
          type: "discord",
          tool: "discord",
          input: { action: step.action },
          output: err.message,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        };

        ctx.registerStep(step.stepId || step.name, step.alias, {
          input: { action: step.action },
          prompt: null,
          output: err.message,
          raw: err,
          success: false,
          timestamp: new Date(),
          duration: Date.now() - start,
        });

        ctx.results.push(result);
        ctx.last = { input: { action: step.action }, output: err.message };

        return result;
      }
    }

    // ----- MCP TOOL -----
    if (step.type === "mcp") {
      const toolName = step.toolName || step.name;
      const args = step.args || {};

      const resolvedArgs = {};
      for (const [key, value] of Object.entries(args)) {
        resolvedArgs[key] = typeof value === "string" ? interpolate(value, ctx) : value;
      }

      const result = await invokeMcpTool(toolName, resolvedArgs, ctx);

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: resolvedArgs,
        prompt: null,
        output: result,
        raw: result,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: resolvedArgs, output: result };

      return result;
    }

    // ----- PARALLEL / JOIN -----
    if (step.type === "parallel") {
      const result = {
        stepId: step.stepId || null,
        type: "parallel",
        tool: "parallel",
        input: "Parallel Execution Start",
        output: "Branching...",
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: "Parallel Execution Start",
        prompt: null,
        output: "Branching...",
        raw: null,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: "Parallel Execution Start", output: "Branching..." };

      return result;
    }

    if (step.type === "join") {
      const outputMsg = ctx.last?.output || "Branches Merged";
      const result = {
        stepId: step.stepId || null,
        type: "join",
        tool: "join",
        input: "Merging Branches",
        output: outputMsg,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      };

      ctx.registerStep(step.stepId || step.name, step.alias, {
        input: "Merging Branches",
        prompt: null,
        output: outputMsg,
        raw: null,
        success: true,
        timestamp: new Date(),
        duration: Date.now() - start,
      });

      ctx.results.push(result);
      ctx.last = { input: "Merging Branches", output: outputMsg };

      return result;
    }

    // ----- UNKNOWN STEP TYPE -----
    const result = {
      stepId: step.stepId || null,
      type: step.type || "unknown",
      tool: step.tool || "unknown",
      input: null,
      output: `Unknown step type: ${step.type}`,
      success: false,
      timestamp: new Date(),
      duration: Date.now() - start,
    };

    ctx.registerStep(step.stepId || step.name, step.alias, {
      input: null,
      prompt: null,
      output: `Unknown step type: ${step.type}`,
      raw: null,
      success: false,
      timestamp: new Date(),
      duration: Date.now() - start,
    });

    ctx.results.push(result);
    ctx.last = { input: null, output: `Unknown step type: ${step.type}` };

    return result;

  } catch (err) {
    const result = {
      stepId: step.stepId || null,
      type: step.type || "unknown",
      tool: step.tool || "unknown",
      input: "[error]",
      output: err.message,
      success: false,
      error: (err && err.stack) ? String(err.stack).slice(0, 2000) : undefined,
      timestamp: new Date(),
      duration: Date.now() - start,
    };

    ctx.registerStep(step.stepId || step.name, step.alias, {
      input: "[error]",
      prompt: null,
      output: err.message,
      raw: err,
      success: false,
      timestamp: new Date(),
      duration: Date.now() - start,
    });

    ctx.results.push(result);
    ctx.last = { input: "[error]", output: err.message };

    return result;
  }
}

module.exports = { executeStep };