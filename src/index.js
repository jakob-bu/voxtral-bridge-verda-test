import http from "node:http";

import { WebSocketServer } from "ws";

import { bridgeSession } from "./bridge-session.js";
import { loadConfig } from "./config.js";
import { buildErrorEvent, getAuthorizationToken } from "./protocol.js";

const config = loadConfig();

if (config.backend === "voxtral" && !config.voxtralModelDir) {
  console.error("[voxtral-bridge] BACKEND=voxtral requires VOXTRAL_MODEL_DIR");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wsServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

function log(event, meta = {}) {
  const payload = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[voxtral-bridge] ${event}${payload}`);
}

function isListenPath(pathname, listenPath) {
  if (pathname === listenPath) {
    return true;
  }

  if (pathname === "/listen" || pathname === "/stt/listen") {
    return true;
  }

  return pathname.endsWith("/listen");
}

function hasValidApiKey(request) {
  if (!config.requiredApiKey) {
    return true;
  }

  const token = getAuthorizationToken(request.headers);
  return token === config.requiredApiKey;
}

function rejectUnauthorizedUpgrade(request, socket, head) {
  wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
    try {
      clientSocket.send(JSON.stringify(buildErrorEvent("Invalid API key")));
    } finally {
      setTimeout(() => {
        if (clientSocket.readyState === clientSocket.OPEN) {
          clientSocket.close(1008, "unauthorized");
        }
      }, 50);
    }
  });
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (!isListenPath(url.pathname, config.listenPath)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!hasValidApiKey(request)) {
    rejectUnauthorizedUpgrade(request, socket, head);
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
    bridgeSession({
      clientSocket,
      request,
      requestUrl: url,
      config,
      log,
    });
  });
});

server.listen(config.port, config.host, () => {
  const meta = {
    backend: config.backend,
    host: config.host,
    port: config.port,
    listen_path: config.listenPath,
  };

  if (config.backend === "voxtral") {
    meta.voxtral_bin = config.voxtralBin;
    meta.voxtral_model_dir = config.voxtralModelDir;
  } else {
    meta.vllm_realtime_url = config.vllmRealtimeUrl;
  }

  log("listening", meta);
});
