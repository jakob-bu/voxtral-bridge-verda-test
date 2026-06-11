import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "mistralai/Voxtral-Mini-4B-Realtime-2602";

function loadDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) {
    return;
  }

  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function normalizeBackend(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "voxtral") {
    return "voxtral";
  }
  return "vllm";
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizePath(pathValue) {
  if (!pathValue) {
    return "/stt/listen";
  }
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

export function loadConfig() {
  loadDotEnv();

  return {
    backend: normalizeBackend(process.env.BACKEND ?? "vllm"),
    host: process.env.HOST ?? "127.0.0.1",
    port: envInt("PORT", 8787),
    listenPath: normalizePath(process.env.LISTEN_PATH),
    vllmRealtimeUrl:
      process.env.VLLM_REALTIME_URL ?? "ws://127.0.0.1:8000/v1/realtime",
    vllmApiKey: process.env.VLLM_API_KEY?.trim() || "",
    requiredApiKey:
      process.env.REQUIRED_API_KEY?.trim() ||
      process.env.INBOUND_API_KEY?.trim() ||
      "",
    voxtralBin: process.env.VOXTRAL_BIN?.trim() || "voxtral",
    voxtralModelDir: process.env.VOXTRAL_MODEL_DIR?.trim() || "",
    defaultModel: process.env.DEFAULT_MODEL?.trim() || DEFAULT_MODEL,
  };
}
