// backend/src/tools/registry.js
const { fork } = require("child_process");
const path = require("path");

/**
 * Executes a tool in a separate process container for security/isolation.
 * @param {string} toolName - Name of the tool in the index registry (e.g. 'fileTool')
 * @param {string} functionName - Function to call on the tool (e.g. 'write')
 * @param {Array} args - Arguments to pass to the function
 * @returns {Promise<any>} The result of the tool execution
 */
function runToolInSandbox(toolName, functionName, args = []) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "sandboxWorker.js");

    const uid = process.env.TOOL_SANDBOX_UID ? Number(process.env.TOOL_SANDBOX_UID) : undefined;
    const gid = process.env.TOOL_SANDBOX_GID ? Number(process.env.TOOL_SANDBOX_GID) : undefined;
    const timeoutMs = process.env.TOOL_EXECUTION_TIMEOUT_MS ? Number(process.env.TOOL_EXECUTION_TIMEOUT_MS) : 30000;

    const allowedEnv = {
      IS_SANDBOX: "true"
    };

    // System-critical environment variables required for binary execution (e.g. Chrome/Puppeteer)
    const SYSTEM_ENV_VARS = ["PATH", "HOME", "USER", "NODE_ENV", "PWD"];
    for (const key of SYSTEM_ENV_VARS) {
      if (process.env[key] !== undefined) {
        allowedEnv[key] = process.env[key];
      }
    }

    // Explicitly allowed variables for non-sensitive tool configurations
    const TOOL_CONFIG_VARS = [
      "FILE_BASE_DIR",
      "PUPPETEER_HEADLESS",
      "MAIL_HOST",
      "MAIL_PORT",
      "MAIL_USER",
      "MAIL_PASS",
      "MAIL_FROM",
      "EMAIL_HOST",
      "EMAIL_PORT",
      "EMAIL_USER",
      "EMAIL_PASS",
      "EMAIL_FROM"
    ];
    for (const key of TOOL_CONFIG_VARS) {
      if (process.env[key] !== undefined) {
        allowedEnv[key] = process.env[key];
      }
    }

    const forkOpts = {
      stdio: ["inherit", "inherit", "inherit", "ipc"], // inherit standard output/error, enable IPC
      execArgv: ["--max-old-space-size=256"], // limit process memory allocation
      env: allowedEnv
    };

    if (uid !== undefined && !isNaN(uid)) {
      forkOpts.uid = uid;
    }
    if (gid !== undefined && !isNaN(gid)) {
      forkOpts.gid = gid;
    }

    const child = fork(workerPath, [], forkOpts);

    let finished = false;

    // Timeout guard to prevent hanging or infinite-looping tool runs
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try {
          child.kill("SIGKILL");
        } catch (e) {
          // ignore kill errors
        }
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    child.on("message", (response) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (response && response.success) {
        resolve(response.result);
      } else {
        reject(new Error(response ? response.error : "Unknown execution error"));
      }
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Sandbox worker exited with code ${code}`));
      } else {
        resolve(null);
      }
    });

    // Dispatch job to the child process
    child.send({ toolName, functionName, args });
  });
}

module.exports = { runToolInSandbox };
