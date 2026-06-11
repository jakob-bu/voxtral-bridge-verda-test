import {
  MIN_SECONDS_PER_WORD,
  MIN_SPEAKER_SWITCH_WORD_SEC,
  MIN_SPEAKER_WINDOW_SEC,
  SPEAKER_SILENCE_FLOOR,
  SPEAKER_SWITCH_BIAS,
} from "./constants.js";
import { tokenizeTranscript } from "./helpers.js";

function inferSpeakerForWindow(state, query, startSec, endSec) {
  if (query.channels <= 1) {
    state.lastResolvedSpeaker = 0;
    return 0;
  }

  if (query.channels !== 2) {
    return null;
  }

  let left = 0;
  let right = 0;

  for (const segment of state.channelActivity) {
    if (segment.endSec <= startSec) {
      continue;
    }
    if (segment.startSec >= endSec) {
      break;
    }

    const overlapSec =
      Math.min(endSec, segment.endSec) - Math.max(startSec, segment.startSec);
    if (overlapSec <= 0) {
      continue;
    }

    const segmentSpan = Math.max(1e-6, segment.endSec - segment.startSec);
    const overlapRatio = overlapSec / segmentSpan;
    left += segment.leftEnergy * overlapRatio;
    right += segment.rightEnergy * overlapRatio;
  }

  let speaker;
  const total = left + right;
  if (total < SPEAKER_SILENCE_FLOOR) {
    speaker = state.lastResolvedSpeaker ?? 0;
  } else if (left > right * SPEAKER_SWITCH_BIAS) {
    speaker = 0;
  } else if (right > left * SPEAKER_SWITCH_BIAS) {
    speaker = 1;
  } else {
    speaker = state.lastResolvedSpeaker ?? (left >= right ? 0 : 1);
  }

  if (
    state.lastResolvedSpeaker !== null &&
    speaker !== state.lastResolvedSpeaker &&
    endSec - startSec < MIN_SPEAKER_SWITCH_WORD_SEC
  ) {
    speaker = state.lastResolvedSpeaker;
  }

  state.lastResolvedSpeaker = speaker;
  return speaker;
}

function inferSpeakerForWord(state, query, startSec, endSec) {
  let windowStart = startSec;
  let windowEnd = endSec;
  const span = Math.max(0, windowEnd - windowStart);
  if (span < MIN_SPEAKER_WINDOW_SEC) {
    const missing = MIN_SPEAKER_WINDOW_SEC - span;
    windowStart = Math.max(0, windowStart - missing / 2);
    windowEnd += missing / 2;
  }

  windowEnd = Math.min(state.totalAudioSeconds, windowEnd);
  if (windowEnd <= windowStart) {
    windowStart = Math.max(0, state.totalAudioSeconds - MIN_SPEAKER_WINDOW_SEC);
    windowEnd = state.totalAudioSeconds;
  }

  return inferSpeakerForWindow(state, query, windowStart, windowEnd);
}

export function updateWordsFromTranscript({ state, query, log }) {
  const tokens = tokenizeTranscript(state.fullTranscript);
  if (!tokens.length) {
    return;
  }

  if (tokens.length < state.words.length) {
    log("transcript_tokens_shrank", {
      from: state.words.length,
      to: tokens.length,
    });
    return;
  }

  for (let index = 0; index < state.words.length && index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    state.words[index].word = token;
    state.words[index].punctuated_word = token;
  }

  const newCount = tokens.length - state.words.length;
  if (newCount <= 0) {
    return;
  }

  const availableSec = Math.max(0, state.totalAudioSeconds - state.lastWordEndSec);
  const perWordSec = Math.max(MIN_SECONDS_PER_WORD, availableSec / newCount);

  for (let index = state.words.length; index < tokens.length; index += 1) {
    const token = tokens[index];
    const startSec = state.lastWordEndSec;
    const endSec = startSec + perWordSec;

    state.words.push({
      word: token,
      punctuated_word: token,
      start: startSec,
      end: endSec,
      confidence: 1.0,
      speaker: inferSpeakerForWord(state, query, startSec, endSec),
      language: query.language ?? null,
    });
    state.lastWordEndSec = endSec;
  }
}
