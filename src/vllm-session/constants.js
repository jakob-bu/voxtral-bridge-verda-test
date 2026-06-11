export const FINALIZATION_TICK_MS = 500;
export const IDLE_KEEPALIVE_TICK_MS = 1000;
export const IDLE_KEEPALIVE_AFTER_MS = 4000;
export const IDLE_KEEPALIVE_AUDIO_MS = 20;
export const CLIENT_RESULTS_HEARTBEAT_TICK_MS = 1000;
export const CLIENT_RESULTS_HEARTBEAT_AFTER_MS = 2500;

export const MIN_SECONDS_PER_WORD = 0.18;
export const SPEAKER_SWITCH_BIAS = 1.08;
export const SPEAKER_SILENCE_FLOOR = 1;
export const MIN_SPEAKER_SWITCH_WORD_SEC = 0.24;
export const MIN_SPEAKER_WINDOW_SEC = 0.8;
export const MAX_CHANNEL_ACTIVITY_SEGMENTS = 120000;

export const CHUNK_OVERLAP_SEC = 0.75;
export const CHUNK_COMMIT_MIN_INTERVAL_MS = 700;
export const ADAPTIVE_TICK_MS = 5000;
export const METRICS_TICK_MS = 10000;

export const NORMAL_MODE = "normal";
export const SPEED_MODE = "speed";
export const RECOVERY_MODE = "recovery";

export const MAX_DEDUPE_WORDS = 24;
export const FINALIZED_TAIL_WORDS = 48;

export const MODE_CONFIG = {
  [NORMAL_MODE]: {
    chunkSec: 18,
    holdbackMs: 5000,
    contextSec: 8 * 60,
  },
  [SPEED_MODE]: {
    chunkSec: 14,
    holdbackMs: 3500,
    contextSec: 5 * 60,
  },
  [RECOVERY_MODE]: {
    chunkSec: 10,
    holdbackMs: 2500,
    contextSec: 4 * 60,
  },
};
