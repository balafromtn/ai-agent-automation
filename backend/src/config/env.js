const { z } = require("zod");

const envSchema = z.object({
  // server
  PORT: z.coerce
    .number()
    .int()
    .min(1, "PORT must be greater than 0")
    .max(65535, "PORT must be less than 65536")
    .optional(),

  // database
  MONGO_URI: z
    .string({
      required_error: "Missing MONGO_URI",
    })
    .min(1, "Missing MONGO_URI")
    .refine(
      (value) =>
        value.startsWith("mongodb://") ||
        value.startsWith("mongodb+srv://"),
      {
        message: "Invalid MONGO_URI",
      }
    ),

  // auth
  JWT_SECRET: z
    .string({
      required_error: "Missing JWT_SECRET",
    })
    .min(32, "JWT_SECRET must be at least 32 characters"),

  // optional AI providers
  OLLAMA_HOST: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  HF_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // worker
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive("WORKER_POLL_INTERVAL_MS must be a positive number")
    .optional(),

  WORKER_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive("WORKER_BATCH_SIZE must be a positive number")
    .optional(),

  WORKER_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive("WORKER_MAX_ATTEMPTS must be a positive number")
    .optional(),

  WORKER_CONCURRENCY_LIMIT: z.coerce
    .number()
    .int()
    .positive("WORKER_CONCURRENCY_LIMIT must be a positive number")
    .optional(),

  WORKER_SERVICE_TOKEN: z.string().optional(),

  // email
  EMAIL_HOST: z.string().optional(),

  EMAIL_PORT: z.coerce
    .number()
    .int()
    .min(1, "EMAIL_PORT must be greater than 0")
    .max(65535, "EMAIL_PORT must be less than 65536")
    .optional(),

  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // telemetry
  TELEMETRY_ENABLED: z.coerce.boolean().optional(),

  DISABLE_ALL_ANALYTICS: z.coerce.boolean().optional(),

  TELEMETRY_ENDPOINT: z.string().optional(),

  // rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive("RATE_LIMIT_WINDOW_MS must be a positive number")
    .optional(),

  RATE_LIMIT_GLOBAL_MAX: z.coerce
    .number()
    .int()
    .positive("RATE_LIMIT_GLOBAL_MAX must be a positive number")
    .optional(),

  RATE_LIMIT_AUTH_MAX: z.coerce
    .number()
    .int()
    .positive("RATE_LIMIT_AUTH_MAX must be a positive number")
    .optional(),

  RATE_LIMIT_EXPENSIVE_MAX: z.coerce
    .number()
    .int()
    .positive("RATE_LIMIT_EXPENSIVE_MAX must be a positive number")
    .optional(),

  RATE_LIMIT_WEBHOOK_MAX: z.coerce
    .number()
    .int()
    .positive("RATE_LIMIT_WEBHOOK_MAX must be a positive number")
    .optional(),

  // tool sandbox isolation options
  TOOL_SANDBOX_UID: z.coerce
    .number()
    .int()
    .positive("TOOL_SANDBOX_UID must be a positive number")
    .optional(),

  TOOL_SANDBOX_GID: z.coerce
    .number()
    .int()
    .positive("TOOL_SANDBOX_GID must be a positive number")
    .optional(),

  TOOL_EXECUTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive("TOOL_EXECUTION_TIMEOUT_MS must be a positive number")
    .optional(),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("\n❌ Environment Validation Failed:\n");

    result.error.issues.forEach((issue) => {
      console.error(`- ${issue.message}`);
    });

    console.error("\n🛑 Server startup aborted.\n");

    process.exit(1);
  }

  console.log("✅ Environment variables validated successfully.\n");
}

module.exports = validateEnv;