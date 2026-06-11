import { WebSocket } from "ws";

import {
  buildErrorEvent,
  buildResultsEventFromWordEntries,
  downmixIfNeeded,
  getAuthorizationToken,
  makeSessionMetadata,
  parseQuerySettings,
} from "./protocol.js";
import {
  ADAPTIVE_TICK_MS,
  CHUNK_COMMIT_MIN_INTERVAL_MS,
  CHUNK_OVERLAP_SEC,
  CLIENT_RESULTS_HEARTBEAT_AFTER_MS,
  CLIENT_RESULTS_HEARTBEAT_TICK_MS,
  FINALIZED_TAIL_WORDS,
  FINALIZATION_TICK_MS,
  IDLE_KEEPALIVE_AFTER_MS,
  IDLE_KEEPALIVE_TICK_MS,
  METRICS_TICK_MS,
} from "./vllm-session/constants.js";
import { getModeConfig, selectAdaptiveMode } from "./vllm-session/adaptive.js";
import {
  buildClientResultsKeepaliveEvent,
  buildSilenceChunkBase64,
  captureStereoActivity,
  makeTranscriptFromWords,
  normalizeWordForDedupe,
  safeParseJson,
  splitWordsByChannel,
  toText,
  trimLeadingOverlapWords,
} from "./vllm-session/helpers.js";
import { createInitialState } from "./vllm-session/state.js";
import { updateWordsFromTranscript } from "./vllm-session/transcript.js";

export function bridgeVllmSession({
  clientSocket,
  request,
  requestUrl,
  config,
  log,
}) {
  const query = parseQuerySettings(requestUrl.searchParams, config.defaultModel);
  const incomingApiKey = getAuthorizationToken(request.headers);
  const upstreamApiKey = config.vllmApiKey || incomingApiKey;

  const headers = {};
  if (upstreamApiKey) {
    headers.Authorization = `Bearer ${upstreamApiKey}`;
  }

  const upstream = new WebSocket(config.vllmRealtimeUrl, { headers });
  const silenceKeepaliveBase64 = buildSilenceChunkBase64(query.sampleRate);
  const state = createInitialState(makeSessionMetadata(query.model));

  function sendClient(payload) {
    if (clientSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (payload?.type === "Results") {
      state.lastClientResultsAtMs = Date.now();
    }
    clientSocket.send(JSON.stringify(payload));
  }

  function sendClientError(message) {
    sendClient(buildErrorEvent(message));
  }

  function sendUpstream(event) {
    if (upstream.readyState !== WebSocket.OPEN) {
      return;
    }
    upstream.send(JSON.stringify(event));
  }

  function flushPendingAudio() {
    for (const base64Audio of state.pendingAudio) {
      sendUpstream({
        type: "input_audio_buffer.append",
        audio: base64Audio,
      });
    }
    state.pendingAudio = [];
  }

  function getLagSeconds() {
    return Math.max(0, state.totalAudioSeconds - state.finalizedAudioSec);
  }

  function updateAdaptiveMode() {
    const nextMode = selectAdaptiveMode(state.currentMode, getLagSeconds());
    if (nextMode === state.currentMode) {
      return;
    }

    const previous = state.currentMode;
    state.currentMode = nextMode;
    const lagSec = Number(getLagSeconds().toFixed(2));
    log("adaptive_mode_changed", {
      from: previous,
      to: nextMode,
      lag_s: lagSec,
      chunk_s: getModeConfig(nextMode).chunkSec,
      context_s: getModeConfig(nextMode).contextSec,
    });
  }

  function logAdaptiveMetrics() {
    const nowMs = Date.now();
    const wallDeltaSec = Math.max(1e-3, (nowMs - state.lastMetricAtMs) / 1000);
    const finalizedDeltaSec = Math.max(
      0,
      state.finalizedAudioSec - state.lastMetricFinalizedAudioSec,
    );
    const rtf = finalizedDeltaSec / wallDeltaSec;
    const lagSec = getLagSeconds();
    const modeConfig = getModeConfig(state.currentMode);

    log("adaptive_metrics", {
      mode: state.currentMode,
      lag_s: Number(lagSec.toFixed(2)),
      finalized_audio_s: Number(state.finalizedAudioSec.toFixed(2)),
      total_audio_s: Number(state.totalAudioSeconds.toFixed(2)),
      rtf: Number(rtf.toFixed(3)),
      chunk_target_s: modeConfig.chunkSec,
      context_target_s: modeConfig.contextSec,
    });

    state.lastMetricAtMs = nowMs;
    state.lastMetricFinalizedAudioSec = state.finalizedAudioSec;
  }

  function rememberRecentMonoAudio(monoBuffer, durationSec) {
    if (!monoBuffer.length || durationSec <= 0) {
      return;
    }

    state.recentMonoChunks.push({
      buffer: monoBuffer,
      durationSec,
    });

    let retained = 0;
    for (let index = state.recentMonoChunks.length - 1; index >= 0; index -= 1) {
      retained += state.recentMonoChunks[index].durationSec;
      if (retained > CHUNK_OVERLAP_SEC + 0.35) {
        state.recentMonoChunks.splice(0, index);
        break;
      }
    }
  }

  function buildRecentOverlapBuffer() {
    const neededSec = CHUNK_OVERLAP_SEC;
    if (neededSec <= 0 || !state.recentMonoChunks.length) {
      return null;
    }

    let remaining = neededSec;
    const parts = [];
    for (let index = state.recentMonoChunks.length - 1; index >= 0; index -= 1) {
      const chunk = state.recentMonoChunks[index];
      const takeSec = Math.min(remaining, chunk.durationSec);
      const ratio = takeSec / chunk.durationSec;
      const takeBytes = Math.max(
        2,
        Math.floor((chunk.buffer.length * ratio) / 2) * 2,
      );
      parts.unshift(chunk.buffer.subarray(chunk.buffer.length - takeBytes));
      remaining -= takeSec;
      if (remaining <= 1e-3) {
        break;
      }
    }

    if (!parts.length) {
      return null;
    }

    return Buffer.concat(parts);
  }

  function commitChunk({ force = false, final = false, reason }) {
    if (!state.upstreamReady || !state.sawAudio) {
      return false;
    }

    if (state.sentFinalCommit) {
      return false;
    }

    const nowMs = Date.now();
    const modeConfig = getModeConfig(state.currentMode);
    const chunkTargetSec = modeConfig.chunkSec;
    if (!force && state.audioSinceCommitSec < chunkTargetSec) {
      return false;
    }

    if (
      !force &&
      nowMs - state.lastChunkCommitAtMs < CHUNK_COMMIT_MIN_INTERVAL_MS
    ) {
      return false;
    }

    const lagSec = Number(getLagSeconds().toFixed(2));
    const chunkId = state.chunkIdCounter + 1;
    state.chunkIdCounter = chunkId;
    state.lastChunkCommitAtMs = nowMs;
    state.audioSinceCommitSec = 0;

    if (final) {
      state.sentFinalCommit = true;
      sendUpstream({ type: "input_audio_buffer.commit", final: true });
      log("chunk_commit", {
        chunk_id: chunkId,
        final: true,
        reason,
        mode: state.currentMode,
        lag_s: lagSec,
      });
      return true;
    }

    sendUpstream({ type: "input_audio_buffer.commit" });
    log("chunk_commit", {
      chunk_id: chunkId,
      final: false,
      reason,
      mode: state.currentMode,
      lag_s: lagSec,
      chunk_target_s: chunkTargetSec,
    });

    const overlapBuffer = buildRecentOverlapBuffer();
    if (overlapBuffer && overlapBuffer.length) {
      sendUpstream({
        type: "input_audio_buffer.append",
        audio: overlapBuffer.toString("base64"),
      });
    }

    return true;
  }

  function startGenerationIfNeeded() {
    if (state.generationStarted || !state.upstreamReady || !state.sawAudio) {
      return;
    }

    const started = commitChunk({
      force: true,
      final: false,
      reason: "initial",
    });
    if (started) {
      state.generationStarted = true;
    }
  }

  function sendFinalizeIfNeeded() {
    if (state.finalizeRequested) {
      return;
    }

    state.finalizeRequested = true;
    stopIdleKeepaliveTicker();

    if (state.sentFinalCommit || !state.upstreamReady || !state.sawAudio) {
      return;
    }

    commitChunk({
      force: true,
      final: true,
      reason: "finalize",
    });
  }

  function emitResultsFromWords({
    words,
    transcript,
    isFinal,
    speechFinal,
    fromFinalize,
  }) {
    const groups = splitWordsByChannel(words, query.channels);
    if (!groups.length) {
      return;
    }

    for (const group of groups) {
      const groupTranscript =
        groups.length > 1 ? makeTranscriptFromWords(group.words) : transcript;
      if (!groupTranscript) {
        continue;
      }

      const event = buildResultsEventFromWordEntries({
        words: group.words,
        transcript: groupTranscript,
        channels: query.channels,
        channelIndex: group.channelIndex,
        language: query.language,
        metadata: state.metadata,
        isFinal,
        speechFinal,
        fromFinalize,
      });

      if (event) {
        sendClient(event);
      }
    }
  }

  function emitPartialResults() {
    if (!state.words.length || state.finalizedWordCount >= state.words.length) {
      return;
    }

    const words = state.words.slice(state.finalizedWordCount);
    const transcript = makeTranscriptFromWords(words);
    if (!transcript) {
      return;
    }

    emitResultsFromWords({
      words,
      transcript,
      isFinal: false,
      speechFinal: false,
      fromFinalize: false,
    });
  }

  function computeFinalizableWordCount(force) {
    if (!state.words.length) {
      return 0;
    }

    if (force) {
      return state.words.length;
    }

    const holdbackMs = getModeConfig(state.currentMode).holdbackMs;
    const cutoffSec = state.totalAudioSeconds - holdbackMs / 1000;
    if (cutoffSec <= 0) {
      return state.finalizedWordCount;
    }

    let index = state.finalizedWordCount;
    while (index < state.words.length && state.words[index].end <= cutoffSec) {
      index += 1;
    }

    return index;
  }

  function emitFinalizedWords({
    force,
    speechFinal,
    fromFinalize,
  }) {
    const targetCount = computeFinalizableWordCount(force);
    if (targetCount <= state.finalizedWordCount) {
      return false;
    }

    const pendingWords = state.words.slice(state.finalizedWordCount, targetCount);
    const deduped = trimLeadingOverlapWords(
      pendingWords,
      state.finalizedTailNormalized,
    );
    const words = deduped.words;
    const transcript = makeTranscriptFromWords(words);
    if (transcript) {
      emitResultsFromWords({
        words,
        transcript,
        isFinal: true,
        speechFinal,
        fromFinalize,
      });

      const lastWord = words[words.length - 1];
      if (lastWord?.end !== undefined) {
        state.finalizedAudioSec = Math.max(state.finalizedAudioSec, lastWord.end);
      }

      for (const word of words) {
        const normalized = normalizeWordForDedupe(
          word.punctuated_word ?? word.word,
        );
        if (!normalized) {
          continue;
        }
        state.finalizedTailNormalized.push(normalized);
      }
      if (state.finalizedTailNormalized.length > FINALIZED_TAIL_WORDS) {
        state.finalizedTailNormalized.splice(
          0,
          state.finalizedTailNormalized.length - FINALIZED_TAIL_WORDS,
        );
      }
    }

    const consumedLastWord = pendingWords[pendingWords.length - 1];
    if (consumedLastWord?.end !== undefined) {
      state.finalizedAudioSec = Math.max(state.finalizedAudioSec, consumedLastWord.end);
    }

    if (deduped.trimmed > 0) {
      log("chunk_overlap_deduped", {
        trimmed_words: deduped.trimmed,
      });
    }

    state.finalizedWordCount = targetCount;
    return true;
  }

  function startFinalizationTicker() {
    if (state.finalizationTimer) {
      clearInterval(state.finalizationTimer);
    }

    state.finalizationTimer = setInterval(() => {
      const advanced = emitFinalizedWords({
        force: false,
        speechFinal: false,
        fromFinalize: false,
      });
      if (advanced) {
        emitPartialResults();
      }
    }, FINALIZATION_TICK_MS);
  }

  function stopFinalizationTicker() {
    if (!state.finalizationTimer) {
      return;
    }

    clearInterval(state.finalizationTimer);
    state.finalizationTimer = null;
  }

  function sendIdleKeepaliveIfNeeded() {
    if (
      !state.upstreamReady ||
      !state.generationStarted ||
      state.finalizeRequested ||
      !state.sawAudio
    ) {
      return;
    }

    const nowMs = Date.now();
    if (
      state.lastClientAudioAtMs <= 0 ||
      nowMs - state.lastClientAudioAtMs < IDLE_KEEPALIVE_AFTER_MS
    ) {
      return;
    }

    sendUpstream({
      type: "input_audio_buffer.append",
      audio: silenceKeepaliveBase64,
    });

    state.lastClientAudioAtMs = nowMs;
  }

  function startIdleKeepaliveTicker() {
    if (state.idleKeepaliveTimer) {
      clearInterval(state.idleKeepaliveTimer);
    }

    state.idleKeepaliveTimer = setInterval(() => {
      sendIdleKeepaliveIfNeeded();
    }, IDLE_KEEPALIVE_TICK_MS);
  }

  function stopIdleKeepaliveTicker() {
    if (!state.idleKeepaliveTimer) {
      return;
    }

    clearInterval(state.idleKeepaliveTimer);
    state.idleKeepaliveTimer = null;
  }

  function startAdaptiveTicker() {
    if (state.adaptiveTimer) {
      clearInterval(state.adaptiveTimer);
    }

    state.adaptiveTimer = setInterval(() => {
      updateAdaptiveMode();
    }, ADAPTIVE_TICK_MS);
  }

  function stopAdaptiveTicker() {
    if (!state.adaptiveTimer) {
      return;
    }

    clearInterval(state.adaptiveTimer);
    state.adaptiveTimer = null;
  }

  function startMetricsTicker() {
    if (state.metricsTimer) {
      clearInterval(state.metricsTimer);
    }

    state.metricsTimer = setInterval(() => {
      logAdaptiveMetrics();
    }, METRICS_TICK_MS);
  }

  function stopMetricsTicker() {
    if (!state.metricsTimer) {
      return;
    }

    clearInterval(state.metricsTimer);
    state.metricsTimer = null;
  }

  function sendClientResultsHeartbeatIfNeeded() {
    if (
      !state.upstreamReady ||
      (state.finalizeRequested && state.receivedFinalDone)
    ) {
      return;
    }

    const nowMs = Date.now();
    if (nowMs - state.lastClientResultsAtMs < CLIENT_RESULTS_HEARTBEAT_AFTER_MS) {
      return;
    }

    sendClient(
      buildClientResultsKeepaliveEvent({
        metadata: state.metadata,
        channels: query.channels,
      }),
    );
  }

  function startClientResultsHeartbeatTicker() {
    if (state.clientResultsHeartbeatTimer) {
      clearInterval(state.clientResultsHeartbeatTimer);
    }

    state.clientResultsHeartbeatTimer = setInterval(() => {
      sendClientResultsHeartbeatIfNeeded();
    }, CLIENT_RESULTS_HEARTBEAT_TICK_MS);
  }

  function stopClientResultsHeartbeatTicker() {
    if (!state.clientResultsHeartbeatTimer) {
      return;
    }

    clearInterval(state.clientResultsHeartbeatTimer);
    state.clientResultsHeartbeatTimer = null;
  }

  function mergeCompletedTranscript(text) {
    if (typeof text !== "string") {
      return;
    }

    const incoming = text.trim();
    if (!incoming) {
      return;
    }

    const current = state.fullTranscript.trim();
    if (!current) {
      state.fullTranscript = incoming;
      return;
    }

    if (incoming.length < current.length) {
      return;
    }

    if (incoming.startsWith(current)) {
      state.fullTranscript = incoming;
    }
  }

  function processAudioBuffer(rawBuffer) {
    state.lastClientAudioAtMs = Date.now();
    const chunkStartSec = state.totalAudioSeconds;
    if (query.channels === 2) {
      captureStereoActivity(rawBuffer, query.sampleRate, chunkStartSec, state);
    }

    const monoBuffer = downmixIfNeeded(rawBuffer, query.channels);
    const bytesPerSample = 2; // PCM16
    const sampleCount = Math.floor(monoBuffer.length / bytesPerSample);
    const durationSec = sampleCount / query.sampleRate;
    state.totalAudioSeconds += durationSec;
    state.audioSinceCommitSec += durationSec;
    state.sawAudio = true;
    rememberRecentMonoAudio(monoBuffer, durationSec);

    const audioBase64 = monoBuffer.toString("base64");

    if (!state.upstreamReady) {
      state.pendingAudio.push(audioBase64);
      return;
    }

    sendUpstream({
      type: "input_audio_buffer.append",
      audio: audioBase64,
    });
    const progressMark =
      state.totalAudioSeconds < 1
        ? 0
        : Math.floor(state.totalAudioSeconds / 15) + 1;

    if (progressMark !== state.lastAudioProgressMark) {
      state.lastAudioProgressMark = progressMark;
      log("audio_progress", {
        total_audio_s: Number(state.totalAudioSeconds.toFixed(2)),
        channels: query.channels,
        sample_rate: query.sampleRate,
        lag_s: Number(getLagSeconds().toFixed(2)),
        mode: state.currentMode,
      });
    }

    updateAdaptiveMode();
    startGenerationIfNeeded();
    commitChunk({
      force: false,
      final: false,
      reason: "chunk_target",
    });
  }

  startFinalizationTicker();
  startIdleKeepaliveTicker();
  startClientResultsHeartbeatTicker();
  startAdaptiveTicker();
  startMetricsTicker();

  clientSocket.on("message", (data, isBinary) => {
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      processAudioBuffer(buffer);
      return;
    }

    const control = safeParseJson(toText(data));
    if (!control) {
      if (!state.loggedNonJsonText) {
        state.loggedNonJsonText = true;
        const text = toText(data);
        log("client_text_ignored", {
          preview: text.slice(0, 64),
          length: text.length,
        });
      }
      return;
    }

    if (typeof control.type !== "string") {
      return;
    }

    if (!state.seenControlTypes.has(control.type)) {
      state.seenControlTypes.add(control.type);
      log("client_control", { type: control.type });
    }

    if (control.type === "Finalize" || control.type === "CloseStream") {
      sendFinalizeIfNeeded();
      emitFinalizedWords({
        force: true,
        speechFinal: true,
        fromFinalize: true,
      });
      return;
    }
  });

  clientSocket.on("close", () => {
    sendFinalizeIfNeeded();
    emitFinalizedWords({
      force: true,
      speechFinal: true,
      fromFinalize: true,
    });
    stopFinalizationTicker();
    stopIdleKeepaliveTicker();
    stopClientResultsHeartbeatTicker();
    stopAdaptiveTicker();
    stopMetricsTicker();
    setTimeout(() => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close(1000, "client closed");
      }
    }, 250);
  });

  clientSocket.on("error", (err) => {
    log("client_error", { error: err.message });
    sendFinalizeIfNeeded();
    stopFinalizationTicker();
    stopIdleKeepaliveTicker();
    stopClientResultsHeartbeatTicker();
    stopAdaptiveTicker();
    stopMetricsTicker();
  });

  upstream.on("open", () => {
    log("upstream_connected", {
      path: requestUrl.pathname,
      model: query.model,
      channels: query.channels,
      sample_rate: query.sampleRate,
    });
  });

  upstream.on("unexpected-response", (_requestObj, response) => {
    log("upstream_unexpected_response", {
      status: response.statusCode,
      status_text: response.statusMessage,
    });
    sendClientError(
      `vLLM websocket handshake failed (${response.statusCode} ${response.statusMessage})`,
    );
  });

  upstream.on("message", (data) => {
    const parsed = safeParseJson(toText(data));
    if (!parsed || typeof parsed.type !== "string") {
      return;
    }

    if (!state.seenUpstreamTypes.has(parsed.type)) {
      state.seenUpstreamTypes.add(parsed.type);
      log("upstream_event", { type: parsed.type });
    }

    if (parsed.type === "session.created") {
      sendUpstream({ type: "session.update", model: query.model });
      state.upstreamReady = true;
      flushPendingAudio();
      startGenerationIfNeeded();
      return;
    }

    if (
      parsed.type === "transcription.delta" ||
      parsed.type === "conversation.item.input_audio_transcription.delta"
    ) {
      state.fullTranscript += parsed.delta ?? "";
      updateWordsFromTranscript({ state, query, log });
      emitFinalizedWords({
        force: false,
        speechFinal: false,
        fromFinalize: false,
      });
      emitPartialResults();
      return;
    }

    if (
      parsed.type === "transcription.done" ||
      parsed.type === "conversation.item.input_audio_transcription.completed"
    ) {
      if (state.finalizeRequested || state.sentFinalCommit) {
        state.receivedFinalDone = true;
      }
      mergeCompletedTranscript(parsed.text ?? parsed.transcript);

      updateWordsFromTranscript({ state, query, log });
      emitFinalizedWords({
        force: state.finalizeRequested,
        speechFinal: state.finalizeRequested,
        fromFinalize: state.sentFinalCommit && state.finalizeRequested,
      });
      emitPartialResults();
      return;
    }

    if (parsed.type === "error") {
      const detail =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error?.message || "vLLM realtime upstream error";
      log("upstream_error_event", { detail });
      sendClientError(detail);
    }
  });

  upstream.on("close", (code, reason) => {
    log("upstream_closed", { code, reason: toText(reason) });
    stopFinalizationTicker();
    stopIdleKeepaliveTicker();
    stopClientResultsHeartbeatTicker();
    stopAdaptiveTicker();
    stopMetricsTicker();

    emitFinalizedWords({
      force: true,
      speechFinal: true,
      fromFinalize: state.sentFinalCommit,
    });

    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1000, "upstream closed");
    }
  });

  upstream.on("error", (err) => {
    log("upstream_error", { error: err.message });
    stopFinalizationTicker();
    stopIdleKeepaliveTicker();
    stopClientResultsHeartbeatTicker();
    stopAdaptiveTicker();
    stopMetricsTicker();
    sendClientError(`Failed to connect to vLLM realtime: ${err.message}`);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1011, "upstream error");
    }
  });
}
