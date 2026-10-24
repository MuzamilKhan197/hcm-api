import express from "express";
import { createServerlessHandler } from "./src/serverless.js";

// Vercel detects this direct Express import and default export.
// Local app.listen() startup stays in server.js.
export const app = express();
app.disable("x-powered-by");
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store").json({
    service: "HCM Lite API",
    health: "/api/health",
    status: "/api/auth/status",
  });
});
app.use(createServerlessHandler());
export default app;
