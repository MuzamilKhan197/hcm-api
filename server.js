import "dotenv/config";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDemoStore, createMongoStore } from "./src/config/database.js";
import { seedDemo } from "./src/services/seed.js";
import { createApp } from "./src/create-app.js";
const demo = process.argv.includes("--demo");
const production = process.env.NODE_ENV === "production";
try {
  if (production)
    throw new Error("Use the Vercel app export for production; server.js is for local development only.");
  if (demo && production)
    throw new Error("Demo mode is disabled in production.");
  if (
    !demo &&
    (!process.env.JWT_SECRET ||
      process.env.JWT_SECRET.length < 32 ||
      process.env.JWT_SECRET.includes("replace-with"))
  )
    throw new Error(
      "Set a random JWT_SECRET of at least 32 characters in backend/.env.",
    );
  if (!demo && !process.env.MONGODB_URI)
    throw new Error(
      "Set MONGODB_URI in backend/.env, or use npm run dev:demo to explore with sample data.",
    );
  const db = demo
    ? await createDemoStore(
        fileURLToPath(new URL("./data/demo.json", import.meta.url)),
      )
    : await createMongoStore(process.env.MONGODB_URI);
  if (demo) await seedDemo(db);
  const config = {
    jwtSecret: demo ? randomBytes(48).toString("hex") : process.env.JWT_SECRET,
    production,
    clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    serveFrontend: true,
  };
  const app = createApp(db, config);
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, demo ? "127.0.0.1" : "0.0.0.0", () =>
    console.log(
      `HCM Lite API: http://127.0.0.1:${port} (${demo ? "DEMO — local sample data" : "MongoDB"})`,
    ),
  );
  const shutdown = () =>
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  const safeStartupMessages = [
    "Use the Vercel app export for production; server.js is for local development only.",
    "Demo mode is disabled in production.",
    "Set a random JWT_SECRET of at least 32 characters in backend/.env.",
    "Set MONGODB_URI in backend/.env, or use npm run dev:demo to explore with sample data.",
    "MongoDB must use a replica set for atomic setup and payroll. Use MongoDB Atlas or a local replica set; see README.",
  ];
  const details = safeStartupMessages.includes(error.message) ||
    error.message.startsWith("CLIENT_URL") ||
    error.message.startsWith("MONGODB_URI") ||
    error.message.startsWith("JWT_SECRET")
    ? error.message
    : `${error.name}${error.code ? ` (${error.code})` : ""}. Check database connectivity and environment configuration.`;
  console.error(`Startup failed: ${details}`);
  process.exit(1);
}
