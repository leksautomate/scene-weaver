import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import projectsRouter from "./routes/projects.js";
import assetsRouter from "./routes/assets.js";
import regenerateRouter from "./routes/regenerate.js";
import geminiProxyRouter from "./routes/gemini-proxy.js";
import renderRouter from "./routes/render.js";
import scriptToJsonRouter from "./routes/scriptToJson.js";
import textToVideoRouter from "./routes/textToVideo.js";
import authRouter from "./routes/auth.js";
import adminRouter from "./routes/admin.js";
import { requireAuth } from "./middleware/requireAuth.js";

dotenv.config();

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in .env — generate one with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || "5000", 10);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

// Auth routes — public, no token required
app.use("/api/auth", authRouter);

// All other API routes — require valid JWT cookie
app.use("/api", requireAuth);
app.use("/api/projects", projectsRouter);
app.use("/api", assetsRouter);
app.use("/api/regenerate", regenerateRouter);
app.use("/api/gemini-proxy", geminiProxyRouter);
app.use("/api/render", renderRouter);
app.use("/api/script-to-json", scriptToJsonRouter);
app.use("/api/text-to-video", textToVideoRouter);
app.use("/api/admin", adminRouter);

const uploadsDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsDir));

const sfxDir = path.join(process.cwd(), "sfx");
app.use("/sfx", express.static(sfxDir));

const distPath = path.join(__dirname, "../dist");
app.use(express.static(distPath));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
