import http from "node:http";
import { randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

import { buildErrorEvent, getAuthorizationToken } from "./protocol.js";

function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    return fallback;
  }

  return value;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function normalizePath(pathValue) {
  if (!pathValue) {
    return "/stt/listen";
  }
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function toText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return String(data);
}

function normalizeUpstreamBase(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new Error("UPSTREAM_BASE_WS is required");
  }

  const url = new URL(trimmed);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported UPSTREAM_BASE_WS protocol: ${url.protocol}`);
  }

  return url;
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

function getLocalTimeParts(timezone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return {
    weekday: parts.weekday || "???",
    hour: Number.parseInt(parts.hour || "0", 10),
    isoLocal: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function isBusinessHours({
  timezone,
  startHour,
  endHour,
}) {
  const local = getLocalTimeParts(timezone);
  const weekdays = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  const isWeekday = weekdays.has(local.weekday);

  let hourMatch = false;
  if (startHour === endHour) {
    hourMatch = true;
  } else if (startHour < endHour) {
    hourMatch = local.hour >= startHour && local.hour < endHour;
  } else {
    hourMatch = local.hour >= startHour || local.hour < endHour;
  }

  return {
    allowed: isWeekday && hourMatch,
    local,
  };
}

const config = {
  host: process.env.HOST || "0.0.0.0",
  port: envInt("PORT", 8787, { min: 1, max: 65535 }),
  listenPath: normalizePath(process.env.LISTEN_PATH),
  upstreamBase: normalizeUpstreamBase(process.env.UPSTREAM_BASE_WS),
  connectRetryMs: envInt("UPSTREAM_CONNECT_RETRY_MS", 2000, {
    min: 100,
    max: 60000,
  }),
  connectTimeoutMs: envInt("UPSTREAM_CONNECT_TIMEOUT_MS", 30000, {
    min: 250,
    max: 300000,
  }),
  maxBufferBytes: envInt("MAX_BUFFER_BYTES", 128 * 1024 * 1024, {
    min: 1024,
    max: 1024 * 1024 * 1024,
  }),
  warmupKeepaliveMs: envInt("WARMUP_KEEPALIVE_MS", 2000, {
    min: 250,
    max: 60000,
  }),
  blockOutsideHours: envBool("BLOCK_OUTSIDE_HOURS", true),
  businessTimezone: process.env.BUSINESS_TIMEZONE || "Europe/London",
  businessStartHour: envInt("BUSINESS_START_HOUR", 9, { min: 0, max: 23 }),
  businessEndHour: envInt("BUSINESS_END_HOUR", 1, { min: 0, max: 23 }),
  requiredApiKey:
    process.env.REQUIRED_API_KEY?.trim() ||
    process.env.INBOUND_API_KEY?.trim() ||
    "",
};

function log(event, meta = {}) {
  const payload = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[gateway] ${event}${payload}`);
}

function buildUpstreamUrl(requestUrl) {
  const url = new URL(requestUrl.pathname + requestUrl.search, config.upstreamBase);
  return url.toString();
}

function sendClientError(clientSocket, message) {
  if (clientSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  clientSocket.send(JSON.stringify(buildErrorEvent(message)));
}

function hasValidApiKey(request) {
  if (!config.requiredApiKey) {
    return true;
  }

  const token = getAuthorizationToken(request.headers);
  return token === config.requiredApiKey;
}

function createWarmupMetadata() {
  const requestId = `gateway-warmup-${randomUUID()}`;
  return {
    request_id: requestId,
    model_uuid: requestId,
    model_info: {
      name: "gateway-warmup",
      version: "0.1.0",
      arch: "buffer-proxy",
    },
  };
}

function buildWarmupKeepaliveEvent(metadata) {
  return {
    type: "Results",
    start: 0,
    duration: 0,
    is_final: false,
    speech_final: false,
    from_finalize: false,
    channel: {
      alternatives: [],
    },
    metadata,
    channel_index: [0, 1],
  };
}

class BufferedProxySession {
  constructor(clientSocket, request, requestUrl) {
    this.clientSocket = clientSocket;
    this.request = request;
    this.requestUrl = requestUrl;
    this.upstream = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.closed = false;
    this.connecting = false;
    this.retryTimer = null;
    this.connectAttempts = 0;
    this.warmupTimer = null;
    this.warmupMetadata = createWarmupMetadata();
    this.sawUpstreamMessage = false;
  }

  start() {
    this.attachClientHandlers();
    this.startWarmupKeepalive();
    this.tryConnectUpstream();
  }

  attachClientHandlers() {
    this.clientSocket.on("message", (data, isBinary) => {
      if (this.closed) {
        return;
      }

      if (this.upstream?.readyState === WebSocket.OPEN) {
        this.upstream.send(data, { binary: isBinary });
        return;
      }

      this.enqueue(data, isBinary);
    });

    this.clientSocket.on("close", () => {
      this.close();
    });

    this.clientSocket.on("error", (err) => {
      log("client_error", { error: err.message });
      this.close();
    });
  }

  enqueue(data, isBinary) {
    const payload = isBinary ? Buffer.from(data) : toText(data);
    const size = isBinary ? payload.length : Buffer.byteLength(payload, "utf8");
    const nextSize = this.queuedBytes + size;

    if (nextSize > config.maxBufferBytes) {
      sendClientError(
        this.clientSocket,
        `Audio buffer exceeded ${Math.round(config.maxBufferBytes / (1024 * 1024))} MB during backend warmup`,
      );
      this.clientSocket.close(1008, "buffer limit exceeded");
      this.close();
      return;
    }

    this.queue.push({ payload, isBinary, size });
    this.queuedBytes = nextSize;
  }

  flushQueue() {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const item of this.queue) {
      this.upstream.send(item.payload, { binary: item.isBinary });
    }

    if (this.queue.length) {
      log("flushed_buffer", {
        messages: this.queue.length,
        bytes: this.queuedBytes,
        attempt: this.connectAttempts,
      });
    }

    this.queue = [];
    this.queuedBytes = 0;
  }

  sendWarmupKeepalive() {
    if (this.closed || this.sawUpstreamMessage) {
      this.stopWarmupKeepalive();
      return;
    }
    if (this.clientSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.clientSocket.send(
      JSON.stringify(buildWarmupKeepaliveEvent(this.warmupMetadata)),
    );
  }

  startWarmupKeepalive() {
    this.sendWarmupKeepalive();

    if (this.warmupTimer) {
      clearInterval(this.warmupTimer);
      this.warmupTimer = null;
    }

    this.warmupTimer = setInterval(() => {
      this.sendWarmupKeepalive();
    }, config.warmupKeepaliveMs);
  }

  stopWarmupKeepalive() {
    if (this.warmupTimer) {
      clearInterval(this.warmupTimer);
      this.warmupTimer = null;
    }
  }

  scheduleRetry() {
    if (this.closed) {
      return;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.tryConnectUpstream();
    }, config.connectRetryMs);
  }

  tryConnectUpstream() {
    if (this.closed || this.connecting || this.upstream) {
      return;
    }

    this.connectAttempts += 1;
    this.connecting = true;

    const upstreamUrl = buildUpstreamUrl(this.requestUrl);
    const headers = {};
    const authorization = this.request.headers.authorization;
    if (typeof authorization === "string" && authorization.trim()) {
      headers.Authorization = authorization.trim();
    }

    const upstream = new WebSocket(upstreamUrl, {
      headers,
      handshakeTimeout: config.connectTimeoutMs,
    });

    let opened = false;

    upstream.on("open", () => {
      if (this.closed) {
        upstream.close(1000, "client closed");
        return;
      }

      opened = true;
      this.connecting = false;
      this.upstream = upstream;

      log("upstream_connected", {
        path: this.requestUrl.pathname,
        attempt: this.connectAttempts,
      });

      this.flushQueue();
    });

    upstream.on("message", (data, isBinary) => {
      if (this.closed || this.clientSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!this.sawUpstreamMessage) {
        this.sawUpstreamMessage = true;
        this.stopWarmupKeepalive();
      }
      this.clientSocket.send(data, { binary: isBinary });
    });

    upstream.on("error", (err) => {
      log("upstream_error", {
        attempt: this.connectAttempts,
        error: err.message,
      });
    });

    upstream.on("close", (code, reason) => {
      this.connecting = false;
      if (this.upstream === upstream) {
        this.upstream = null;
      }

      log("upstream_closed", {
        code,
        reason: toText(reason),
        opened,
        attempt: this.connectAttempts,
      });

      if (this.closed) {
        return;
      }

      if (opened) {
        sendClientError(this.clientSocket, "Upstream transcription backend closed");
        if (this.clientSocket.readyState === WebSocket.OPEN) {
          this.clientSocket.close(1011, "upstream closed");
        }
        this.close();
        return;
      }

      this.scheduleRetry();
    });
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopWarmupKeepalive();

    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
      try {
        this.upstream.close(1000, "client closed");
      } catch {
        // no-op
      }
    }

    this.upstream = null;
    this.queue = [];
    this.queuedBytes = 0;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    const business = isBusinessHours({
      timezone: config.businessTimezone,
      startHour: config.businessStartHour,
      endHour: config.businessEndHour,
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        upstream_base_ws: config.upstreamBase.origin,
        outside_hours_blocked: config.blockOutsideHours,
        business_hours_active: business.allowed,
        local_time: business.local.isoLocal,
        local_weekday: business.local.weekday,
      }),
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wsServer = new WebSocketServer({ noServer: true });

function rejectUnauthorizedUpgrade(request, socket, head) {
  wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
    sendClientError(clientSocket, "Invalid API key");
    setTimeout(() => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close(1008, "unauthorized");
      }
    }, 50);
  });
}

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (!isListenPath(requestUrl.pathname, config.listenPath)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!hasValidApiKey(request)) {
    rejectUnauthorizedUpgrade(request, socket, head);
    return;
  }

  const business = isBusinessHours({
    timezone: config.businessTimezone,
    startHour: config.businessStartHour,
    endHour: config.businessEndHour,
  });

  if (config.blockOutsideHours && !business.allowed) {
    wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
      sendClientError(
        clientSocket,
        `Service is offline outside business hours (${config.businessStartHour}:00-${config.businessEndHour}:00 ${config.businessTimezone}, Mon-Fri)`,
      );
      setTimeout(() => {
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.close(1000, "outside business hours");
        }
      }, 50);
    });
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
    log("client_connected", {
      path: requestUrl.pathname,
      queued_limit_mb: Math.round(config.maxBufferBytes / (1024 * 1024)),
      local_time: business.local.isoLocal,
    });

    const session = new BufferedProxySession(clientSocket, request, requestUrl);
    session.start();
  });
});

server.listen(config.port, config.host, () => {
  log("listening", {
    host: config.host,
    port: config.port,
    listen_path: config.listenPath,
    upstream_base_ws: config.upstreamBase.origin,
    connect_retry_ms: config.connectRetryMs,
    connect_timeout_ms: config.connectTimeoutMs,
    max_buffer_mb: Math.round(config.maxBufferBytes / (1024 * 1024)),
    block_outside_hours: config.blockOutsideHours,
    business_timezone: config.businessTimezone,
    business_window: `${config.businessStartHour}:00-${config.businessEndHour}:00`,
    api_key_required: Boolean(config.requiredApiKey),
  });
});
