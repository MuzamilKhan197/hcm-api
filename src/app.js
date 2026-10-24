import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { authRouter } from "./controllers/auth.js";
import { workspaceRouter } from "./routes/workspace.js";
export function createApp(db, config) {
  const app = express();
  const origins = [
    config.clientUrl,
    ...(!config.production
      ? ["http://localhost:5173", "http://127.0.0.1:5173"]
      : []),
  ].filter(Boolean);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin: (origin, callback) => callback(null, origin && origins.includes(origin) ? origin : false),
    credentials: true,
  }));
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use("/api", (req, res, next) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const nonRead = !["GET", "HEAD"].includes(req.method);
    if (config.production && unsafe && !req.headers.origin)
      return res.status(403).json({ message: "A trusted request origin is required." });
    if (
      req.headers.origin &&
      !origins.includes(req.headers.origin) &&
      nonRead
    )
      return res.status(403).json({ message: "This origin is not allowed." });
    if (
      req.get("sec-fetch-site") === "cross-site" &&
      (!req.headers.origin || !origins.includes(req.headers.origin))
    )
      return res
        .status(403)
        .json({ message: "Cross-site requests are not allowed." });
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60 * 1000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { message: "Please slow down and try again in a minute." },
    }),
  );
  app.get("/api/health", async (req, res) => {
    await db.health();
    res.json({ ok: true, storage: db.mode });
  });
  app.use("/api/auth", authRouter(db, config));
  app.use("/api", workspaceRouter(db, config));
  app.use("/api", (req, res) =>
    res.status(404).json({ message: "This API endpoint does not exist." }),
  );
  const frontend = fileURLToPath(
    new URL("../../frontend/dist", import.meta.url),
  );
  if (config.serveFrontend !== false && existsSync(frontend)) {
    app.use(express.static(frontend));
    app.get("/{*path}", (req, res) =>
      res.sendFile(path.join(frontend, "index.html")),
    );
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === 11000)
      return res
        .status(409)
        .json({ message: "A record with these details already exists." });
    if (
      error.name === "ValidationError" ||
      error.type === "entity.parse.failed"
    )
      return res
        .status(400)
        .json({ message: "Please check the submitted fields." });
    if (!error.status || error.status >= 500)
      console.error("Request failed:", error.name, error.message);
    res.status(error.status || 500).json({
      message:
        error.status && error.status < 500
          ? error.message
          : "Something went wrong. Please try again.",
    });
  });
  return app;
}
