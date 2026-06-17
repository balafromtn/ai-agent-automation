require('dotenv').config();

const handlers = {
  llm: require('./handlers/llm.handler'),
  delay: require('./handlers/delay.handler'),
  http: require('./handlers/http.handler'),
  email: require('./handlers/email.handler'),
  file: require('./handlers/file.handler'),
  browser: require('./handlers/browser.handler'),
  document_query: require('./handlers/document.handler'),
  condition: require('./handlers/condition.handler'),
  switch: require('./handlers/switch.handler'),
  mcp: require('./handlers/mcp.handler'),
  tool: require('./handlers/tool.handler'),
};

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

async function internalExecuteStep(step, context, agent, validatedStepId, timeoutMs) {
  const stepType = String(step.type || '').toLowerCase();
  
  const handler = handlers[stepType];

  if (!handler) {
    return {
      stepId: validatedStepId,
      type: stepType,
      output: `Unknown step type: ${stepType}`,
      success: false,
      timestamp: new Date(),
    };
  }

  return handler.execute(
    step,
    context,
    agent,
    validatedStepId,
    timeoutMs
  );
}

module.exports = { executeStep };
