import { randomUUID } from "node:crypto";

const MIN_SECONDS_PER_WORD = 0.18;

function roundMillis(seconds) {
  return Math.max(0, Math.round(seconds * 1000));
}

function toSeconds(ms) {
  return ms / 1000;
}

export function getAuthorizationToken(headers) {
  const raw = headers?.authorization;
  if (!raw || typeof raw !== "string") {
    return "";
  }

  const tokenMatch = raw.match(/^\s*Token\s+(.+)\s*$/i);
  if (tokenMatch?.[1]) {
    return tokenMatch[1].trim();
  }

  const bearerMatch = raw.match(/^\s*Bearer\s+(.+)\s*$/i);
  if (bearerMatch?.[1]) {
    return bearerMatch[1].trim();
  }

  return "";
}

export function extractLanguage(searchParams) {
  const all = [];
  for (const value of searchParams.getAll("language")) {
    all.push(...value.split(","));
  }
  for (const value of searchParams.getAll("languages")) {
    all.push(...value.split(","));
  }

  const normalized = all
    .map((v) => v.trim())
    .filter(Boolean)
    .find((v) => v.toLowerCase() !== "multi");

  return normalized || null;
}

export function parseQuerySettings(searchParams, fallbackModel) {
  const channelsRaw = Number.parseInt(searchParams.get("channels") ?? "1", 10);
  const sampleRateRaw = Number.parseInt(
    searchParams.get("sample_rate") ?? "16000",
    10,
  );

  return {
    model: searchParams.get("model") || fallbackModel,
    channels: Number.isFinite(channelsRaw) && channelsRaw > 0 ? channelsRaw : 1,
    sampleRate:
      Number.isFinite(sampleRateRaw) && sampleRateRaw > 0 ? sampleRateRaw : 16000,
    language: extractLanguage(searchParams),
  };
}

export function downmixIfNeeded(buffer, channels) {
  if (channels <= 1) {
    return buffer;
  }

  if (channels !== 2) {
    return buffer;
  }

  const frameCount = Math.floor(buffer.length / 4);
  const out = Buffer.allocUnsafe(frameCount * 2);

  for (let i = 0; i < frameCount; i += 1) {
    const offset = i * 4;
    const left = buffer.readInt16LE(offset);
    const right = buffer.readInt16LE(offset + 2);
    const mixed = Math.round((left + right) / 2);
    out.writeInt16LE(mixed, i * 2);
  }

  return out;
}

function buildWordEntries(transcript, totalAudioSeconds, language) {
  const pieces = transcript
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (!pieces.length) {
    return [];
  }

  const totalMs = Math.max(
    roundMillis(totalAudioSeconds),
    Math.ceil(pieces.length * MIN_SECONDS_PER_WORD * 1000),
  );
  const perWordMs = Math.max(1, Math.floor(totalMs / pieces.length));

  return pieces.map((word, index) => {
    const startMs = index * perWordMs;
    const endMs = Math.min(totalMs, (index + 1) * perWordMs);

    return {
      word,
      punctuated_word: word,
      start: toSeconds(startMs),
      end: toSeconds(endMs),
      confidence: 1.0,
      speaker: null,
      language: language ?? null,
    };
  });
}

function computeEventSpan(words) {
  const start = words[0]?.start ?? 0;
  const end = words[words.length - 1]?.end ?? start;
  return {
    start,
    duration: Math.max(0, end - start),
  };
}

function normalizeWordEntry(word, language) {
  return {
    word: word.word,
    punctuated_word: word.punctuated_word ?? word.word,
    start: word.start,
    end: word.end,
    confidence: word.confidence ?? 1.0,
    speaker: word.speaker ?? null,
    language: word.language ?? language ?? null,
  };
}

function resolveChannelIndex(channelIndex, channels) {
  const totalChannels = Math.max(1, channels);
  if (!Number.isFinite(channelIndex)) {
    return 0;
  }

  const normalized = Math.floor(channelIndex);
  return Math.max(0, Math.min(totalChannels - 1, normalized));
}

export function buildResultsEventFromWordEntries({
  words,
  transcript,
  channels,
  channelIndex = 0,
  language,
  metadata,
  isFinal,
  speechFinal,
  fromFinalize,
}) {
  if (!Array.isArray(words) || words.length === 0) {
    return null;
  }

  const normalizedWords = words.map((word) => normalizeWordEntry(word, language));
  const { start, duration } = computeEventSpan(normalizedWords);

  return {
    type: "Results",
    start,
    duration,
    is_final: isFinal,
    speech_final: speechFinal,
    from_finalize: fromFinalize,
    channel: {
      alternatives: [
        {
          transcript,
          words: normalizedWords,
          confidence: 1.0,
          languages: language ? [language] : [],
        },
      ],
    },
    metadata,
    channel_index: [resolveChannelIndex(channelIndex, channels), Math.max(1, channels)],
  };
}

export function makeSessionMetadata(model) {
  const requestId = `voxtral-bridge-${randomUUID()}`;

  return {
    request_id: requestId,
    model_uuid: requestId,
    model_info: {
      name: model,
      version: "bridge-0.1.0",
      arch: "vllm-realtime",
    },
  };
}

export function buildResultsEvent({
  transcript,
  totalAudioSeconds,
  channels,
  language,
  metadata,
  isFinal,
  speechFinal,
  fromFinalize,
}) {
  const words = buildWordEntries(transcript, totalAudioSeconds, language);
  return buildResultsEventFromWordEntries({
    words,
    transcript,
    channels,
    language,
    metadata,
    isFinal,
    speechFinal,
    fromFinalize,
  });
}

export function buildErrorEvent(message) {
  return {
    type: "Error",
    error_code: null,
    error_message: message,
    provider: "deepgram",
  };
}
