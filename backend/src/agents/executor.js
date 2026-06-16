// backend/src/agents/executor.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runLLM } = require('./llmAdapter');
const { invokeTool: invokeMcpTool } = require('../mcp/executionAdapter');
const { hasTool, dispatchTool } = require('../tools/registry');
require('dotenv').config();

// ─── UTILITY FUNCTIONS (MOVED TO TOP TO PREVENT REFERENCE ERRORS) ──────────────────

function interpolate(template = '', context = {}) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(.*?)\}\}/g, (_, key) => {
    const parts = key.trim().split('.');
    let val = context;
    for (const p of parts) {
      if (val === undefined || val === null) break;
      val = val[p];
    }
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') return JSON.stringify(val, null, 2);
    return String(val);
  });
}

function resolveWorkflowFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Invalid file path');
  }

  if (filePath.includes('\0')) {
    throw new Error('Invalid file path');
  }

  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error('Invalid file path: absolute paths are not allowed');
  }

  const workflowBaseDir = path.resolve(process.cwd(), 'runtime', 'workflow-files');
  const resolvedPath = path.resolve(workflowBaseDir, filePath);
  const relativePath = path.relative(workflowBaseDir, resolvedPath);

  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Invalid file path: path escapes workflow directory');
  }

  return normalized;
}

async function executeStep(step, context = {}, agent = null) {
  const validatedStepId = step.stepId || step.id || step.name || null;
  const explicitTimeout = Number(step.timeoutMs ?? step.timeout);
  const finalTimeoutMs = !isNaN(explicitTimeout) && explicitTimeout > 0 ? explicitTimeout : 30000;

  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Step execution timed out after ${finalTimeoutMs}ms`));
    }, finalTimeoutMs);
  });

  try {
    const result = await Promise.race([
      internalExecuteStep(step, context, agent, validatedStepId, finalTimeoutMs),
      timeoutPromise,
    ]);

    return result;
  } catch (err) {
    const isTimeout = err.message?.includes('timed out');
    return {
      stepId: validatedStepId,
      type: step.type || 'unknown',
      tool: step.tool || 'unknown',
      input: isTimeout ? '[timeout]' : '[error]',
      output: err.message,
      success: false,
      error: err.stack ? String(err.stack).slice(0, 2000) : undefined,
      timestamp: new Date(),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Isolated Tool Processing Logic - Completely Decoupled Platform Implementation
 */
async function internalExecuteStep(step, context, agent, validatedStepId, finalTimeoutMs) {
  const stepType = String(step.type || '').toLowerCase();

  // ----- CORE ORCHESTRATION ENGINE PRIMITIVES -----
  if (stepType === 'llm') {
    const prompt = interpolate(step.prompt, context);
    let finalPrompt = prompt;
    let memoryMetrics = null;

    if (step.useMemory && agent) {
      const { retrieveMemory } = require('../services/memoryService');
      const memories = await retrieveMemory(agent, prompt, step.memoryTopK || 5);

      if (memories.length > 0) {
        const similarityScores = memories.map((m) => (typeof m.score === 'number' ? m.score : 0));
        const averageSimilarity =
          similarityScores.reduce((acc, s) => acc + s, 0) / similarityScores.length;

        memoryMetrics = {
          useMemory: true,
          retrievedMemoriesCount: memories.length,
          similarityScores,
          averageSimilarity: Math.round(averageSimilarity * 1000) / 1000,
        };

        const MAX_MEMORY_CHARS = 4000;
        let memoryText = memories
          .map((m, i) => {
            const parsed = JSON.parse(m.content);
            return `Memory ${i + 1}:\nUser: ${parsed.user}\nAssistant: ${parsed.assistant}`;
          })
          .join('\n\n');

        if (memories.length > 0) {
          const MAX_MEMORY_CHARS = 4000;

          let memoryText = memories
            .map((m, i) => {
              const parsed = JSON.parse(m.content);
              return `Memory ${i + 1}:\nUser: ${parsed.user}\nAssistant: ${parsed.assistant}`;
            })
            .join("\n\n");

        finalPrompt = `SYSTEM INSTRUCTION:\nYou are an AI agent with persistent memory.\nThe following MEMORY is factual and must be used when answering.\n\nMEMORY:\n${memoryText}\n\nUSER QUESTION:\n${prompt}\n\nUse the MEMORY section to answer the question.`;
      } else {
        memoryMetrics = {
          useMemory: true,
          retrievedMemoriesCount: 0,
          similarityScores: [],
          averageSimilarity: 0,
        };
      }

      return result;
    }

    const llmRes = await runLLM(finalPrompt, {
      provider: agent?.config?.provider,
      model: agent?.config?.model,
      temperature: agent?.config?.temperature,
      ...step.options,
    });

    const result = {
      stepId: validatedStepId,
      type: 'llm',
      tool: 'llm',
      input: prompt,
      output: llmRes.text,
      raw: llmRes.raw,
      success: true,
      timestamp: new Date(),
      ...(memoryMetrics ? { metrics: memoryMetrics } : {}),
    };

    if (step.useMemory && agent && llmRes.text) {
      const { storeMemory } = require('../services/memoryService');
      await storeMemory(agent, JSON.stringify({ user: prompt, assistant: llmRes.text }), {
        taskId: context.taskId,
        workflowId: context.workflow?._id,
        type: 'conversation',
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

  if (stepType === 'delay') {
    const sec = Number(step.seconds ?? step.delay ?? step.prompt ?? 0);
    console.log('⏳ Delay step → sleeping for', sec, 'seconds');
    await new Promise((resolve) => setTimeout(resolve, sec * 1000));

    return {
      stepId: validatedStepId,
      type: 'delay',
      tool: 'delay',
      input: sec,
      output: `Slept for ${sec} seconds`,
      success: true,
      timestamp: new Date(),
    };
  }

  if (stepType === 'http') {
    let parsedBody = null;
    if (step.body) {
      const interpolated = interpolate(step.body, context);
      try {
        parsedBody = JSON.parse(interpolated);
      } catch (err) {
        parsedBody = interpolated;
      }
    }

    const response = await axios({
      method: (step.method || 'GET').toLowerCase(),
      url: interpolate(step.url || '', context),
      data: parsedBody,
      headers: step.headers || {},
      timeout: step.timeout || 30000,
      validateStatus: () => true,
    });

    return {
      stepId: validatedStepId,
      type: 'http',
      tool: 'http',
      input: interpolate(step.url || '', context),
      output: response.data,
      success: response.status >= 200 && response.status < 300,
      timestamp: new Date(),
    };
  }

  // ─── DYNAMIC TOOL DISCOVERY & REGISTRY LOOKUP CONTRACT HANDOFF ──────────────────
  if (hasTool(stepType)) {
    try {
      const toolResult = await dispatchTool(stepType, step, context);
      return {
        stepId: validatedStepId,
        type: stepType,
        tool: stepType,
        input: step.input || step.action || '[staged_sandbox_input]',
        output: toolResult,
        success: true,
        timestamp: new Date()
      };
    } catch (toolError) {
      // Gracefully capture sandbox configuration or execution failures without crashing or obscuring data
      return {
        stepId: validatedStepId,
        type: stepType,
        tool: stepType,
        input: step.action || '[sandbox_error_input]',
        output: toolError.message,
        success: false,
        error: toolError.stack ? String(toolError.stack).slice(0, 1000) : undefined,
        timestamp: new Date()
      };
    }

  // ----- INTEGRATIONS & BASELINE CONDITIONAL ENGINES -----
  if (stepType === 'document_query') {
    const { queryDocument } = require('../services/documentService');
    const query = interpolate(step.query || '', context);
    const chunks = await queryDocument(agent, context.userId, step.documentId, query, step.topK || 3);

    let contextText = chunks.map((c, i) => `Chunk ${i + 1}:\n${c.content}`).join('\n\n');
    if (contextText.length > 3000) contextText = contextText.slice(0, 3000);

    const finalPrompt = `DOCUMENT CONTEXT:\n${contextText}\n\nQUESTION:\n${query}`;
    const llmRes = await runLLM(finalPrompt, {
      provider: agent?.config?.provider,
      model: agent?.config?.model,
      temperature: agent?.config?.temperature,
    });

    return {
      stepId: validatedStepId,
      type: 'document_query',
      tool: 'document',
      input: query,
      output: llmRes.text,
      success: true,
      timestamp: new Date(),
    };
  }

  if (stepType === 'condition') {
    const normalize = (val) => String(val || '').toLowerCase().trim().replace(/[^\w\s]/g, '');
    const rawOutput = context.last?.output || '';
    let evaluation = false;

    if (step.conditionType === 'boolean') {
      const prompt = `Question:\n${context.results[0]?.input || ''}\n\nAnswer:\n${rawOutput}\n\nRespond only with true or false.`;
      const aiResult = await runLLM(prompt, {
        provider: agent?.config?.provider,
        model: agent?.config?.model,
        temperature: 0,
      });
      evaluation = aiResult.text.toLowerCase().includes('true');
    }
    return {
      stepId: validatedStepId,
      type: 'condition',
      output: evaluation,
      branch: evaluation ? 'true' : 'false',
      success: true,
      timestamp: new Date(),
    };
  }

  if (stepType === 'switch') {
    const output = String(context.last?.output || '').toLowerCase().trim();
    return {
      stepId: validatedStepId,
      type: 'switch',
      tool: 'switch',
      input: output,
      output,
      caseValue: output,
      success: true,
      timestamp: new Date(),
    };
  }

  if (stepType === 'mcp') {
    const execution = await invokeMcpTool({
      userId: context.userId,
      serverId: step.serverId,
      toolName: step.toolName,
      argumentsInput: step.arguments,
      context,
      interpolate,
      timeoutMs: finalTimeoutMs,
    });
    return {
      stepId: validatedStepId,
      type: 'mcp',
      tool: 'mcp',
      output: execution.result,
      success: true,
      timestamp: new Date(),
    };
  }

  return {
    stepId: validatedStepId,
    type: step.type || 'unknown',
    tool: step.tool || 'unknown',
    input: null,
    output: `Unknown step type or missing tool registry mapping: ${step.type}`,
    success: false,
    timestamp: new Date(),
  };
}

module.exports = { executeStep };