function createStepResult({ stepId, type, tool, input, output, success, error, raw, branch, caseValue, metrics }) {
  const result = {
    stepId,
    type,
    tool: tool || type,
    success,
    timestamp: new Date(),
  };

  if (input !== undefined) result.input = input;
  if (output !== undefined) result.output = output;
  if (raw !== undefined) result.raw = raw;
  if (branch !== undefined) result.branch = branch;
  if (caseValue !== undefined) result.caseValue = caseValue;
  if (metrics !== undefined) result.metrics = metrics;
  if (error !== undefined) result.error = error;

  return result;
}

module.exports = { createStepResult };