import {
  IDLE_KEEPALIVE_AUDIO_MS,
  MAX_CHANNEL_ACTIVITY_SEGMENTS,
  MAX_DEDUPE_WORDS,
} from "./constants.js";

export function toText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return String(data);
}

export function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function tokenizeTranscript(transcript) {
  if (!transcript) {
    return [];
  }
  return transcript
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function makeTranscriptFromWords(words) {
  return words
    .map((word) => word.punctuated_word ?? word.word ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function getWordChannel(word, channels, fallbackChannel) {
  if (channels !== 2) {
    return 0;
  }

  const speaker = word?.speaker;
  if (speaker === 0 || speaker === 1) {
    return speaker;
  }

  return fallbackChannel;
}

export function splitWordsByChannel(words, channels) {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }

  const totalChannels = Math.max(1, channels);
  if (totalChannels !== 2) {
    return [{ channelIndex: 0, words }];
  }

  const groups = [];
  let fallbackChannel = 0;
  let currentChannel = getWordChannel(words[0], totalChannels, fallbackChannel);
  fallbackChannel = currentChannel;
  let currentWords = [words[0]];

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    const channel = getWordChannel(word, totalChannels, fallbackChannel);
    fallbackChannel = channel;

    if (channel !== currentChannel) {
      groups.push({ channelIndex: currentChannel, words: currentWords });
      currentChannel = channel;
      currentWords = [word];
      continue;
    }

    currentWords.push(word);
  }

  groups.push({ channelIndex: currentChannel, words: currentWords });
  return groups;
}

export function buildSilenceChunkBase64(sampleRate) {
  const sampleCount = Math.max(
    1,
    Math.round((sampleRate * IDLE_KEEPALIVE_AUDIO_MS) / 1000),
  );
  return Buffer.alloc(sampleCount * 2).toString("base64");
}

export function buildClientResultsKeepaliveEvent({ metadata, channels }) {
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
    channel_index: [0, Math.max(1, channels)],
  };
}

export function normalizeWordForDedupe(word) {
  return (word ?? "")
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

export function trimLeadingOverlapWords(words, finalizedTailNormalized) {
  if (!words.length || !finalizedTailNormalized.length) {
    return {
      words,
      trimmed: 0,
    };
  }

  const normalized = words.map((word) =>
    normalizeWordForDedupe(word.punctuated_word ?? word.word),
  );
  const max = Math.min(
    MAX_DEDUPE_WORDS,
    finalizedTailNormalized.length,
    normalized.length,
  );

  let best = 0;
  for (let size = max; size >= 1; size -= 1) {
    let match = true;
    const tailStart = finalizedTailNormalized.length - size;
    for (let index = 0; index < size; index += 1) {
      if (finalizedTailNormalized[tailStart + index] !== normalized[index]) {
        match = false;
        break;
      }
    }
    if (match) {
      best = size;
      break;
    }
  }

  return {
    words: words.slice(best),
    trimmed: best,
  };
}

export function captureStereoActivity(rawBuffer, sampleRate, chunkStartSec, state) {
  const frameCount = Math.floor(rawBuffer.length / 4);
  if (frameCount <= 0) {
    return;
  }

  let leftEnergy = 0;
  let rightEnergy = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const offset = index * 4;
    const left = rawBuffer.readInt16LE(offset);
    const right = rawBuffer.readInt16LE(offset + 2);
    leftEnergy += Math.abs(left);
    rightEnergy += Math.abs(right);
  }

  const durationSec = frameCount / sampleRate;
  state.channelActivity.push({
    startSec: chunkStartSec,
    endSec: chunkStartSec + durationSec,
    leftEnergy,
    rightEnergy,
  });

  if (state.channelActivity.length > MAX_CHANNEL_ACTIVITY_SEGMENTS) {
    state.channelActivity.splice(
      0,
      state.channelActivity.length - MAX_CHANNEL_ACTIVITY_SEGMENTS,
    );
  }
}
