// backend/src/tools/sandboxWorker.js
const tools = require("./index");

process.on("message", async (msg) => {
  const { toolName, functionName, args = [] } = msg;
  try {
    const tool = tools[toolName];
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found in registry.`);
    }

    const fn = tool[functionName];
    if (typeof fn !== "function") {
      throw new Error(`Function "${functionName}" not found on tool "${toolName}".`);
    }

    // Run the tool function
    const result = await fn(...(Array.isArray(args) ? args : [args]));

    // Send back success and result
    process.send({ success: true, result });
    process.exit(0);
  } catch (error) {
    process.send({ success: false, error: error.message });
    process.exit(1);
  }
});
