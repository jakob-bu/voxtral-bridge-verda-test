import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { WebSocket } from "ws";

import { loadConfig } from "./config.js";

async function httpProbe(url) {
  try {
    const response = await fetch(url, { method: "GET" });
    const text = await response.text();
    return {
      ok: true,
      status: response.status,
      bodyPreview: text.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function wsProbe(url, apiKey) {
  return new Promise((resolve) => {
    const headers = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const ws = new WebSocket(url, { headers });
    let settled = false;

    const done = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      try {
        ws.close();
      } catch {
        // no-op
      }
    };

    ws.on("open", () => {
      done({ ok: true, message: "WebSocket opened successfully" });
    });

    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (text.includes("session.created")) {
        done({
          ok: true,
          message: "Received session.created from vLLM realtime",
        });
      }
    });

    ws.on("unexpected-response", (_req, response) => {
      done({
        ok: false,
        message: `Handshake failed: ${response.statusCode} ${response.statusMessage}`,
      });
    });

    ws.on("error", (error) => {
      done({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    ws.on("close", (code, reason) => {
      if (!settled) {
        done({
          ok: false,
          message: `Closed before ready: code=${code} reason=${String(reason)}`,
        });
      }
    });

    setTimeout(() => {
      done({ ok: false, message: "Timed out waiting for websocket response" });
    }, 5000).unref();
  });
}

function probeVoxtral(config) {
  const modelDir = path.resolve(config.voxtralModelDir || ".");
  const requiredFiles = [
    "consolidated.safetensors",
    "params.json",
    "tekken.json",
  ];
  const missingFiles = requiredFiles.filter(
    (filename) => !fs.existsSync(path.join(modelDir, filename)),
  );

  const help = spawnSync(config.voxtralBin, ["--help"], {
    encoding: "utf8",
  });

  const binaryOk = !help.error && help.status !== 127;

  return {
    binary: {
      ok: binaryOk,
      message: help.error
        ? help.error.message
        : `exit=${help.status ?? "unknown"} ${(
            help.stdout || help.stderr || ""
          ).slice(0, 200)}`,
    },
    modelDir: {
      ok: !missingFiles.length,
      message: missingFiles.length
        ? `Missing files: ${missingFiles.join(", ")}`
        : `Found expected files in ${modelDir}`,
    },
  };
}

async function runVllmDoctor(config) {
  let realtimeHttp;
  try {
    const realtimeUrl = new URL(config.vllmRealtimeUrl);
    realtimeHttp = `${realtimeUrl.protocol.startsWith("wss") ? "https" : "http"}://${realtimeUrl.host}`;
  } catch {
    console.error("Invalid VLLM_REALTIME_URL:", config.vllmRealtimeUrl);
    process.exit(1);
  }

  const [health, models, ws] = await Promise.all([
    httpProbe(`${realtimeHttp}/health`),
    httpProbe(`${realtimeHttp}/v1/models`),
    wsProbe(config.vllmRealtimeUrl, config.vllmApiKey),
  ]);

  console.log("[HTTP /health]");
  if (health.ok) {
    console.log(`  OK ${health.status} ${health.bodyPreview}`);
  } else {
    console.log(`  FAIL ${health.error}`);
  }

  console.log("[HTTP /v1/models]");
  if (models.ok) {
    console.log(`  OK ${models.status} ${models.bodyPreview}`);
  } else {
    console.log(`  FAIL ${models.error}`);
  }

  console.log("[WS /v1/realtime]");
  if (ws.ok) {
    console.log(`  OK ${ws.message}`);
  } else {
    console.log(`  FAIL ${ws.message}`);
  }

  const success = health.ok || models.ok || ws.ok;
  process.exit(success ? 0 : 1);
}

function runVoxtralDoctor(config) {
  const result = probeVoxtral(config);

  console.log("[voxtral binary]");
  if (result.binary.ok) {
    console.log(`  OK ${result.binary.message}`);
  } else {
    console.log(`  FAIL ${result.binary.message}`);
  }

  console.log("[voxtral model dir]");
  if (result.modelDir.ok) {
    console.log(`  OK ${result.modelDir.message}`);
  } else {
    console.log(`  FAIL ${result.modelDir.message}`);
  }

  process.exit(result.binary.ok && result.modelDir.ok ? 0 : 1);
}

async function main() {
  const config = loadConfig();

  console.log("== Voxtral Bridge Doctor ==");
  console.log("backend      :", config.backend);
  console.log("bridge listen :", `${config.host}:${config.port}${config.listenPath}`);
  console.log("");

  if (config.backend === "voxtral") {
    console.log("voxtral bin  :", config.voxtralBin);
    console.log("voxtral model:", config.voxtralModelDir || "(not set)");
    console.log("");
    runVoxtralDoctor(config);
    return;
  }

  console.log("vLLM realtime:", config.vllmRealtimeUrl);
  console.log("");
  await runVllmDoctor(config);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
