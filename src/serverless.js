import { createMongoStore } from "./config/database.js";
import { createApp } from "./create-app.js";

export function readServerConfig(env) {
  const production = env.NODE_ENV === "production" || env.VERCEL === "1" ||
    ["production", "preview"].includes(env.VERCEL_ENV);
  if (!env.MONGODB_URI) throw new Error("Set MONGODB_URI in the backend Vercel project and redeploy.");
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET.includes("replace-with")) {
    throw new Error("Set a random JWT_SECRET of at least 32 characters in the backend Vercel project and redeploy.");
  }
  if (production && !env.CLIENT_URL) throw new Error("Set CLIENT_URL to the frontend HTTPS origin in the backend Vercel project and redeploy.");
  let clientUrl = "";
  if (env.CLIENT_URL) {
    let parsed;
    try { parsed = new URL(env.CLIENT_URL.trim()); }
    catch { throw new Error("CLIENT_URL must be a valid frontend origin."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error("CLIENT_URL must contain only the frontend origin, without a path or credentials.");
    }
    if (production && parsed.protocol !== "https:") throw new Error("CLIENT_URL must use HTTPS in production.");
    clientUrl = parsed.origin;
  }
  return {
    mongoUri: env.MONGODB_URI,
    config: {
      jwtSecret: env.JWT_SECRET, production, clientUrl,
      openAiApiKey: env.OPENAI_API_KEY,
      openAiModel: env.OPENAI_MODEL || "gpt-4o-mini",
      serveFrontend: false,
    },
  };
}

export function createServerlessHandler({ env = process.env, connect = createMongoStore } = {}) {
  let application;
  let configurationError;
  function initialize() {
    const { mongoUri, config } = readServerConfig(env);
    let storePromise;
    function getStore() {
      if (!storePromise) {
        storePromise = Promise.resolve().then(() => connect(mongoUri)).catch(error => {
          storePromise = undefined;
          console.error("MongoDB initialization failed:", error.name, error.code || "unknown");
          const unavailable = new Error("Database unavailable");
          unavailable.code = "DATABASE_UNAVAILABLE";
          throw unavailable;
        });
      }
      return storePromise;
    }
    const db = { mode: "mongodb" };
    for (const method of ["health", "all", "one", "insert", "update", "delete", "transaction"]) {
      db[method] = (...args) => getStore().then(store => store[method](...args));
    }
    return createApp(db, config);
  }
  // Initialize middleware once, outside requests, so rate-limit counters are
  // stable. Only the database connection is deferred until it is needed.
  try { application = initialize(); }
  catch (error) { configurationError = error; }
  return (req, res, next) => {
    if (configurationError) {
      console.error("Backend configuration error:", configurationError.message);
      return res.status(503).set("Cache-Control", "no-store").json({
        code: "SERVER_CONFIGURATION_ERROR", message: configurationError.message,
      });
    }
    return application(req, res, next);
  };
}
