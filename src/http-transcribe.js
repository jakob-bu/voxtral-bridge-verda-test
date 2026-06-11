import http from "node:http";
import { performance } from "node:perf_hooks";

import { WebSocket } from "ws";

const host = process.env.HTTP_HOST || "0.0.0.0";
const port = Number.parseInt(process.env.HTTP_PORT || process.env.PORT || "8787", 10);
const bridgeUrl = process.env.BRIDGE_WS_URL || "ws://127.0.0.1:8788/stt/listen";
const requiredApiKey = process.env.INBOUND_API_KEY || process.env.REQUIRED_API_KEY || "";
const trustIngressAuth = process.env.TRUST_INGRESS_AUTH === "1";

function getAuthorizationToken(headers) {
  const value = headers.authorization || headers.Authorization;
  if (!value) return "";
  const match = /^Bearer\s+(.+)$/i.exec(String(value));
  return match?.[1]?.trim() || "";
}

function hasValidApiKey(req) {
  if (trustIngressAuth) return true;
  return !requiredApiKey || getAuthorizationToken(req.headers) === requiredApiKey;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("expected RIFF/WAVE body");
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        byteRate: buf.readUInt32LE(start + 8),
        blockAlign: buf.readUInt16LE(start + 12),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(start, start + size);
      break;
    }

    offset = start + size + (size % 2);
  }

  if (!fmt || !data) throw new Error("missing WAV fmt or data chunk");
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`expected PCM16 WAV, got format=${fmt.audioFormat} bits=${fmt.bitsPerSample}`);
  }

  return { fmt, data, durationSeconds: data.length / fmt.byteRate };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function eventTranscript(evt) {
  return evt?.channel?.alternatives?.[0]?.transcript || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamToBridge({ req, res, wav, startedAt, options }) {
  const { fmt, data, durationSeconds } = wav;
  const streamSeconds = Math.min(durationSeconds, options.maxSeconds);
  const streamBytes =
    Math.floor((streamSeconds * fmt.byteRate) / fmt.blockAlign) * fmt.blockAlign;
  const chunkBytes = Math.max(
    fmt.blockAlign,
    Math.floor(((options.chunkMs / 1000) * fmt.byteRate) / fmt.blockAlign) * fmt.blockAlign,
  );

  const u = new URL(bridgeUrl);
  u.searchParams.set("encoding", "linear16");
  u.searchParams.set("sample_rate", String(fmt.sampleRate));
  u.searchParams.set("channels", String(fmt.channels));
  u.searchParams.set("model", options.model);

  const apiKey = requiredApiKey || getAuthorizationToken(req.headers);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const ws = new WebSocket(u, { headers, perMessageDeflate: false });

  const result = {
    ok: false,
    bridge_open_ms: null,
    first_message_ms: null,
    first_result_ms: null,
    first_nonempty_transcript_ms: null,
    first_final_ms: null,
    sent_audio_ms: null,
    messages: 0,
    result_events: 0,
    final_events: 0,
    nonempty_events: 0,
    last_transcript: "",
  };

  function nowMs() {
    return Math.round(performance.now() - startedAt);
  }

  let settled = false;
  function finish(ok, error = "") {
    if (settled) return;
    settled = true;
    result.ok = ok;
    writeSse(res, ok ? "done" : "error", {
      ...result,
      error,
      total_ms: nowMs(),
    });
    res.end();
    try {
      ws.close();
    } catch {
      // no-op
    }
  }

  async function sendAudio() {
    let offset = 0;
    while (offset < streamBytes && ws.readyState === WebSocket.OPEN) {
      const end = Math.min(streamBytes, offset + chunkBytes);
      ws.send(data.subarray(offset, end), { binary: true });
      offset = end;
      result.sent_audio_ms = Math.round((end / fmt.byteRate) * 1000);
      await sleep(options.chunkMs / options.speed);
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "Finalize" }));
    }
    setTimeout(() => {
      finish(result.result_events > 0, result.result_events > 0 ? "" : "no_result_events");
    }, options.finalWaitMs).unref();
  }

  ws.on("open", () => {
    result.bridge_open_ms = nowMs();
    writeSse(res, "bridge_open", { t_ms: result.bridge_open_ms });
    sendAudio().catch((error) => finish(false, error.message));
  });

  ws.on("message", (raw) => {
    result.messages += 1;
    if (result.first_message_ms === null) result.first_message_ms = nowMs();

    let evt = null;
    try {
      evt = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (evt.type === "Results") {
      result.result_events += 1;
      if (result.first_result_ms === null) {
        result.first_result_ms = nowMs();
        writeSse(res, "first_result", { t_ms: result.first_result_ms });
      }
      if (evt.is_final) {
        result.final_events += 1;
        if (result.first_final_ms === null) result.first_final_ms = nowMs();
      }

      const transcript = eventTranscript(evt);
      if (transcript) {
        result.nonempty_events += 1;
        result.last_transcript = transcript;
        if (result.first_nonempty_transcript_ms === null) {
          result.first_nonempty_transcript_ms = nowMs();
          writeSse(res, "first_transcript", {
            t_ms: result.first_nonempty_transcript_ms,
            transcript,
          });
        }
        writeSse(res, "result", {
          t_ms: nowMs(),
          is_final: Boolean(evt.is_final),
          speech_final: Boolean(evt.speech_final),
          transcript,
        });
      }
    } else if (evt.type === "Error") {
      finish(false, evt.message || "server_error");
    }
  });

  ws.on("error", (error) => {
    finish(false, error instanceof Error ? error.message : String(error));
  });

  ws.on("close", (code) => {
    if (!settled && result.result_events === 0) finish(false, `closed:${code}`);
  });

  setTimeout(() => finish(false, "timeout"), options.timeoutMs).unref();
}

const server = http.createServer(async (req, res) => {
  const startedAt = performance.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bridge_url: bridgeUrl }));
    return;
  }

  if (url.pathname !== "/transcribe-sse" || req.method !== "POST") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  if (!hasValidApiKey(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  try {
    const maxBodyBytes = Number.parseInt(url.searchParams.get("max_body_bytes") || "134217728", 10);
    const body = await readBody(req, maxBodyBytes);
    const wav = parseWav(body);
    const options = {
      model: url.searchParams.get("model") || "mistralai/Voxtral-Mini-4B-Realtime-2602",
      speed: Number.parseFloat(url.searchParams.get("speed") || "1"),
      maxSeconds: Number.parseFloat(url.searchParams.get("max_seconds") || "180"),
      chunkMs: Number.parseInt(url.searchParams.get("chunk_ms") || "250", 10),
      finalWaitMs: Number.parseInt(url.searchParams.get("final_wait_ms") || "30000", 10),
      timeoutMs: Number.parseInt(url.searchParams.get("timeout_ms") || "600000", 10),
    };

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    writeSse(res, "started", {
      t_ms: Math.round(performance.now() - startedAt),
      sample_rate: wav.fmt.sampleRate,
      channels: wav.fmt.channels,
      audio_duration_s: Number(Math.min(wav.durationSeconds, options.maxSeconds).toFixed(3)),
      speed: options.speed,
      body_bytes: body.length,
    });

    await streamToBridge({ req, res, wav, startedAt, options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    } else {
      writeSse(res, "error", { error: message });
      res.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`[voxtral-http] listening on ${host}:${port}, bridge=${bridgeUrl}`);
});
