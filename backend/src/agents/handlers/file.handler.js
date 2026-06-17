const fs = require('fs');
const path = require('path');
const { resolveWorkflowFilePath } = require('../utils/fileResolver');
const { interpolate } = require('../utils/interpolate');
const { createStepResult } = require('../utils/stepResult');

async function execute(step, context, agent, validatedStepId, timeoutMs) {
  const config = step.config || step;
  const filePath = resolveWorkflowFilePath(config.path);

  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
  });

  if (config.action === 'read') {
    return createStepResult({
      stepId: validatedStepId,
      type: 'file',
      output: fs.readFileSync(filePath, 'utf8'),
      success: true,
    });
  }

  const content = interpolate(config.content || context.last?.output || '', context);

  if (config.action === 'append') {
    fs.appendFileSync(filePath, content);
  } else {
    fs.writeFileSync(filePath, content);
  }

  return createStepResult({
    stepId: validatedStepId,
    type: 'file',
    output: filePath,
    success: true,
  });
}

module.exports = { execute };