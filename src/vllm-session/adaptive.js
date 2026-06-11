import { MODE_CONFIG, NORMAL_MODE, RECOVERY_MODE, SPEED_MODE } from "./constants.js";

export function getModeConfig(mode) {
  return MODE_CONFIG[mode] ?? MODE_CONFIG[NORMAL_MODE];
}

export function selectAdaptiveMode(currentMode, lagSec) {
  if (currentMode === RECOVERY_MODE) {
    if (lagSec < 150) {
      return lagSec > 120 ? SPEED_MODE : NORMAL_MODE;
    }
    return RECOVERY_MODE;
  }
  if (currentMode === SPEED_MODE) {
    if (lagSec > 240) {
      return RECOVERY_MODE;
    }
    if (lagSec < 70) {
      return NORMAL_MODE;
    }
    return SPEED_MODE;
  }
  if (lagSec > 240) {
    return RECOVERY_MODE;
  }
  if (lagSec > 120) {
    return SPEED_MODE;
  }
  return NORMAL_MODE;
}
