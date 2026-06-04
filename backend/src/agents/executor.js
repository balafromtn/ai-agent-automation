// backend/src/agents/executor.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { runLLM } = require("./llmAdapter");
const { runGitHub } = require("../integrations/github");
const { runSlack } = require("../integrations/slack");
const { runDiscord } = require("../integrations/discord");
require("dotenv").config();


async function executeStep(step, context = {}, agent = null) {
  const start = Date.now();

  try {
    // ----- LLM -----
    if (step.type === "llm") {
      const prompt = interpolate(step.prompt, context);

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
        timestamp: new Date()
      };

      if (step.useMemory && agent && llmRes.text) {
        const { storeMemory } = require("../services/memoryService");

        await storeMemory(
          agent,
          JSON.stringify({
            user: prompt,
            assistant: llmRes.text
          }),
          {
            taskId: context.taskId,
            workflowId: context.workflow?._id,
            type: "conversation"
          }
        );
      }

      return result;
    }

    // Delay step
    if (step.type === "delay") {
      const sec = Number(
        step.seconds ?? step.delay ?? step.prompt ?? 0
      );


      console.log("⏳ Delay step → sleeping for", sec, "seconds");

      await new Promise(resolve => setTimeout(resolve, sec * 1000));

      return {
        stepId: step.stepId,
        type: "delay",
        tool: "delay",
        input: sec,
        output: `Slept for ${sec} seconds`,
        success: true,
        timestamp: new Date(),
      };
    }


    // ----- HTTP -----
    if (step.type === "http") {
      let parsedBody = null;

      if (step.body) {
        const interpolated = interpolate(step.body, context);
        try {
          parsedBody = JSON.parse(interpolated);
        } catch (err) {
          // fallback to raw string if JSON parse fails
          parsedBody = interpolated;
        }
      }

      const response = await axios({
        method: (step.method || "GET").toLowerCase(),
        url: interpolate(step.url || "", context),
        data: parsedBody,
        headers: step.headers || {},
        timeout: step.timeout || 30000,
        validateStatus: () => true,
      });


      return {
        stepId: step.stepId || null,
        type: "http",
        tool: "http",
        input: interpolate(step.url || "", context),
        output: response.data,
        success: response.status >= 200 && response.status < 300,
        timestamp: new Date()
      };
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

        const to = interpolate(step.to || "", context);
        const subject = interpolate(step.subject || "", context);
        const text = interpolate(step.text || "", context);
        const html = interpolate(step.html || "", context);

        const info = await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
          to,
          subject,
          text,
          html,
        });

        return {
          stepId: step.stepId,
          type: "email",
          tool: "email",
          input: { to, subject, text, html },
          output: {
            messageId: info.messageId,
            accepted: info.accepted,
          },
          success: true,
          timestamp: new Date(),
        };
      } catch (err) {
        return {
          stepId: step.stepId,
          type: "email",
          tool: "email",
          input: null,
          output: err.message,
          success: false,
          timestamp: new Date(),
        };
      }
    }

    // ----- FILE -----
    if (step.type === "file") {
      const action = (step.action || "read").toLowerCase();

      const resolvedPath = step.path
        ? interpolate(step.path, context)
        : `runtime/stepName_${step.name}_TaskId_${context.taskId}.txt`;

      const content = interpolate(step.content || "", context);
      const { runToolInSandbox } = require("../tools/registry");

      try {
        if (action === "write") {
          const res = await runToolInSandbox("fileTool", "write", [resolvedPath, content]);
          return {
            stepId: step.stepId,
            type: "file",
            tool: "file",
            input: { action, path: resolvedPath, content },
            output: { path: res.path },
            success: true,
            timestamp: new Date(),
          };
        }

        if (action === "append") {
          const res = await runToolInSandbox("fileTool", "append", [resolvedPath, content]);
          return {
            stepId: step.stepId,
            type: "file",
            tool: "file",
            input: { action, path: resolvedPath, content },
            output: { path: res.path },
            success: true,
            timestamp: new Date(),
          };
        }

        if (action === "read") {
          const res = await runToolInSandbox("fileTool", "read", [resolvedPath]);
          return {
            stepId: step.stepId,
            type: "file",
            tool: "file",
            input: { action, path: resolvedPath },
            output: res,
            success: true,
            timestamp: new Date(),
          };
        }

        return {
          stepId: step.stepId,
          type: "file",
          tool: "file",
          input: { action },
          output: `Unknown file action: ${action}`,
          success: false,
          timestamp: new Date(),
        };
      } catch (err) {
        return {
          stepId: step.stepId,
          type: "file",
          tool: "file",
          input: { action, path: resolvedPath },
          output: err.message,
          success: false,
          timestamp: new Date(),
        };
      }
    }

    // ----- BROWSER -----
    if (step.type === "browser") {
      const action = (step.action || "screenshot").toLowerCase();
      const url = interpolate(step.url || "", context);
      const { runToolInSandbox } = require("../tools/registry");

      try {
        if (action === "screenshot") {
          const outPath = path.join(
            "runtime",
            `screenshot_${context.taskId}_${Date.now()}.png`
          );

          const res = await runToolInSandbox("browserTool", "screenshot", [url, { path: outPath }]);

          return {
            stepId: step.stepId,
            type: "browser",
            tool: "browser",
            input: { action, url },
            output: { path: res.path },
            success: true,
            timestamp: new Date(),
          };
        }

        if (action === "evaluate") {
          const userCode = step.code || "return document.title;";

          const res = await runToolInSandbox("browserTool", "evaluate", [url, userCode]);
          const result = res.result;

          return {
            stepId: step.stepId,
            type: "browser",
            tool: "browser",
            input: { action, url, code: userCode },
            output: result,
            success: !result?.error,
            timestamp: new Date(),
          };
        }

        return {
          stepId: step.stepId,
          type: "browser",
          tool: "browser",
          input: { action },
          output: `Unknown browser action: ${action}`,
          success: false,
          timestamp: new Date(),
        };
      } catch (err) {
        return {
          stepId: step.stepId,
          type: "browser",
          tool: "browser",
          input: { action, url },
          output: err.message,
          success: false,
          timestamp: new Date(),
        };
      }
    }

    // ----- DOCUMENT QUERY -----
    if (step.type === "document_query") {

      const { queryDocument } = require("../services/documentService");

      const documentId = step.documentId;
      const query = interpolate(step.query || "", context);

      const chunks = await queryDocument(
        agent,
        context.userId,
        documentId,
        query,
        step.topK || 3
      );

      let contextText = chunks
        .map((c, i) => `Chunk ${i + 1}:\n${c.content}`)
        .join("\n\n");

      // prevent very large prompts
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

      return {
        stepId: step.stepId,
        type: "document_query",
        tool: "document",
        input: query,
        output: llmRes.text,
        success: true,
        timestamp: new Date()
      };
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

      const rawOutput = context.last?.output || "";
      const text = normalize(rawOutput);

      let evaluation = false;

      const positiveWords = ["yes", "true", "correct", "right", "positive"];
      const negativeWords = ["no", "false", "incorrect", "wrong", "negative"];

      try {
        // ---------- BOOLEAN ----------
        if (step.conditionType === "boolean") {
          const userQuery = context.results[0]?.input || "";
          const modelAnswer = context.last?.output || "";

          const prompt = `
You are a strict boolean evaluator.

Question:
${userQuery}

Answer:
${modelAnswer}

Does the answer mean TRUE or FALSE?

Respond ONLY with:
true
or
false
`;

          const aiResult = await runLLM(prompt, {
            provider: agent?.config?.provider,
            model: agent?.config?.model,
            temperature: 0,
          });

          const cleaned = aiResult.text.toLowerCase().trim();

          evaluation = cleaned.includes("true");
        }

        // ---------- SENTIMENT ----------
        if (step.conditionType === "sentiment") {
          let result = null;

          if (text.includes("positive")) result = true;
          else if (text.includes("negative")) result = false;

          // 🔥 AI fallback
          if (result === null) {
            const classification = await runLLM(
              `
Reply ONLY "positive" or "negative".

Text:
${rawOutput}
`,
              {
                provider: agent?.config?.provider,
                model: agent?.config?.model,
                temperature: 0,
              }
            );

            const res = normalize(classification.text);

            result = res.includes("positive");
          }

          evaluation =
            step.operator === "isPositive"
              ? result === true
              : result === false;
        }
      } catch (err) {
        console.log("❌ Condition error:", err);
        evaluation = false;
      }

      return {
        stepId: step.stepId,
        type: "condition",
        output: evaluation,
        branch: evaluation ? "true" : "false",
        success: true,
        timestamp: new Date(),
      };
    }

    // ----- SWITCH -----
    if (step.type === "switch") {
      const output = String(context.last?.output || "")
        .toLowerCase()
        .trim();

      console.log("🔀 SWITCH INPUT:", output);

      return {
        stepId: step.stepId,
        type: "switch",
        tool: "switch",
        input: output,
        output: output,
        caseValue: output, // 🔥 KEY FIX
        success: true,
        timestamp: new Date(),
      };
    }

    // ----- GITHUB -----
    if (step.type === "github") {
      try {
        const output = await runGitHub(step, context, interpolate);
        return {
          stepId: step.stepId || null,
          type: "github",
          tool: "github",
          input: { action: step.action },
          output,
          success: true,
          timestamp: new Date(),
        };
      } catch (err) {
        return {
          stepId: step.stepId || null,
          type: "github",
          tool: "github",
          input: { action: step.action },
          output: err.message,
          success: false,
          timestamp: new Date(),
        };
      }
    }

    // ----- SLACK -----
    if (step.type === "slack") {
      try {
        const output = await runSlack(step, context, interpolate);
        return {
          stepId: step.stepId || null,
          type: "slack",
          tool: "slack",
          input: { action: step.action },
          output,
          success: true,
          timestamp: new Date(),
        };
      } catch (err) {
        return {
          stepId: step.stepId || null,
          type: "slack",
          tool: "slack",
          input: { action: step.action },
          output: err.message,
          success: false,
          timestamp: new Date(),
        };
      }
    }
    // ----- DISCORD -----
    if (step.type === "discord") {
      try {
        const output = await runDiscord(step, context, interpolate);
        return {
          stepId: step.stepId || null,
          type: "discord",
          tool: "discord",
          input: { action: step.action },
          output,
          success: true,
          timestamp: new Date(),
        };
      } catch (err) {
        return {
          stepId: step.stepId || null,
          type: "discord",
          tool: "discord",
          input: { action: step.action },
          output: err.message,
          success: false,
          timestamp: new Date(),
        };
      }
    }

    // unknown step type
    return {
      stepId: step.stepId || null,
      type: step.type || "unknown",
      tool: step.tool || "unknown",
      input: null,
      output: `Unknown step type: ${step.type}`,
      success: false,
      timestamp: new Date()
    };
  } catch (err) {
    // return error object (don't leak secrets)
    return {
      stepId: step.stepId || null,
      type: step.type || "unknown",
      tool: step.tool || "unknown",
      input: "[error]",
      output: err.message,
      success: false,
      error: (err && err.stack) ? String(err.stack).slice(0, 2000) : undefined,
      timestamp: new Date()
    };
  } finally {
    // you can log step duration if needed
    // const duration = Date.now() - start;
  }
}

/**
 * Basic template interpolation: {{key}} replaced by context[key]
 */
function interpolate(template = "", context = {}) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{(.*?)\}\}/g, (_, key) => {
    const k = key.trim();
    // support nested keys like input.text
    const parts = k.split(".");
    let val = context;
    for (const p of parts) {
      if (val === undefined || val === null) break;
      val = val[p];
    }
    if (val === undefined || val === null) return "";

    if (typeof val === "object") {
      return JSON.stringify(val, null, 2);
    }

    return String(val);
  });
}

function evaluateExpression(expression, context) {
  try {
    const normalize = (val) => {
      if (typeof val !== "string") return val;

      return val
        .toLowerCase()
        .trim()
        .replace(/[\n\r]+/g, "")
        .replace(/[^\w]/g, "");
    };

    const replaced = expression.replace(/\{\{(.*?)\}\}/g, (_, key) => {
      const path = key.trim().split(".");
      let val = context;

      for (const p of path) {
        val = val?.[p];
      }

      val = normalize(val);

      if (typeof val === "string") return `"${val}"`;
      return val;
    });

    // ALSO normalize literals inside expression
    const cleanedExpression = replaced.replace(/'([^']+)'/g, (_, val) => {
      return `"${normalize(val)}"`;
    });

    return Function(`return (${cleanedExpression})`)();
  } catch (err) {
    console.error("Condition evaluation failed:", err.message);
    return false;
  }
}

module.exports = { executeStep };