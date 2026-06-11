import { spawn } from "node:child_process";

import { WebSocket } from "ws";

import {
  buildErrorEvent,
  buildResultsEvent,
  downmixIfNeeded,
  makeSessionMetadata,
  parseQuerySettings,
} from "./protocol.js";

function toText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return String(data);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function bridgeVoxtralSession({ clientSocket, requestUrl, config, log }) {
  const query = parseQuerySettings(requestUrl.searchParams, config.defaultModel);

  const state = {
    finalized: false,
    processClosed: false,
    fullTranscript: "",
    totalAudioSeconds: 0,
    finalEventSent: false,
    metadata: makeSessionMetadata(query.model),
  };

  function sendClient(payload) {
    if (clientSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    clientSocket.send(JSON.stringify(payload));
  }

  function sendClientError(message) {
    sendClient(buildErrorEvent(message));
  }

  function emitResults({ isFinal, speechFinal, fromFinalize }) {
    const event = buildResultsEvent({
      transcript: state.fullTranscript,
      totalAudioSeconds: state.totalAudioSeconds,
      channels: query.channels,
      language: query.language,
      metadata: state.metadata,
      isFinal,
      speechFinal,
      fromFinalize,
    });

    if (!event) {
      return;
    }

    sendClient(event);
  }

  if (query.sampleRate !== 16000) {
    sendClientError(
      `voxtral backend expects sample_rate=16000 (got ${query.sampleRate})`,
    );
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1003, "unsupported sample rate");
    }
    return;
  }

  if (query.channels > 2) {
    sendClientError(`voxtral backend supports up to 2 channels (got ${query.channels})`);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1003, "unsupported channels");
    }
    return;
  }

  if (!config.voxtralModelDir) {
    sendClientError("VOXTRAL_MODEL_DIR is not configured");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1011, "voxtral model not configured");
    }
    return;
  }

  const voxtralArgs = ["-d", config.voxtralModelDir, "--stdin", "--silent"];
  const upstream = spawn(config.voxtralBin, voxtralArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  log("voxtral_started", {
    command: config.voxtralBin,
    args: voxtralArgs,
    model: query.model,
    channels: query.channels,
    sample_rate: query.sampleRate,
  });

  function finalizeUpstream() {
    if (state.finalized) {
      return;
    }

    state.finalized = true;
    if (!upstream.stdin.destroyed) {
      upstream.stdin.end();
    }
  }

  upstream.stdout.on("data", (chunk) => {
    const text = toText(chunk);
    if (!text) {
      return;
    }

    state.fullTranscript += text;
    emitResults({
      isFinal: false,
      speechFinal: false,
      fromFinalize: state.finalized,
    });
  });

  upstream.stderr.on("data", (chunk) => {
    const message = toText(chunk).trim();
    if (!message) {
      return;
    }

    log("voxtral_stderr", {
      message: message.slice(0, 400),
    });
  });

  upstream.on("error", (err) => {
    log("voxtral_error", { error: err.message });
    sendClientError(`Failed to start voxtral process: ${err.message}`);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1011, "voxtral error");
    }
  });

  upstream.on("close", (code, signal) => {
    state.processClosed = true;
    log("voxtral_closed", { code, signal });

    if (!state.finalEventSent && state.fullTranscript.trim()) {
      state.finalEventSent = true;
      emitResults({
        isFinal: true,
        speechFinal: true,
        fromFinalize: state.finalized,
      });
    } else if (code !== 0 && clientSocket.readyState === WebSocket.OPEN) {
      sendClientError(`voxtral exited with code ${code}`);
    }

    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1000, "upstream closed");
    }
  });

  clientSocket.on("message", (data, isBinary) => {
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const monoBuffer = downmixIfNeeded(buffer, query.channels);
      const bytesPerSample = 2; // PCM16
      const sampleCount = Math.floor(monoBuffer.length / bytesPerSample);
      state.totalAudioSeconds += sampleCount / query.sampleRate;

      if (!upstream.stdin.destroyed) {
        upstream.stdin.write(monoBuffer);
      }
      return;
    }

    const control = safeParseJson(toText(data));
    if (!control || typeof control.type !== "string") {
      return;
    }

    if (control.type === "Finalize" || control.type === "CloseStream") {
      finalizeUpstream();
    }
  });

  clientSocket.on("close", () => {
    finalizeUpstream();

    setTimeout(() => {
      if (!state.processClosed) {
        upstream.kill("SIGTERM");
      }
    }, 500).unref();
  });

  clientSocket.on("error", (err) => {
    log("client_error", { error: err.message });
    finalizeUpstream();
  });
}
