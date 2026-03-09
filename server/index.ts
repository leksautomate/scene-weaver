import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import projectsRouter from "./routes/projects.js";
import assetsRouter from "./routes/assets.js";
import regenerateRouter from "./routes/regenerate.js";
import whiskProxyRouter from "./routes/whisk-proxy.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || "5000", 10);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use("/api/projects", projectsRouter);
app.use("/api", assetsRouter);
app.use("/api/regenerate", regenerateRouter);
app.use("/api/whisk-proxy", whiskProxyRouter);

const uploadsDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsDir));

const distPath = path.join(__dirname, "../dist");
app.use(express.static(distPath));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
