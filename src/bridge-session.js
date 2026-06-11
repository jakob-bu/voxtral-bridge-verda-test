import { bridgeVllmSession } from "./vllm-session.js";
import { bridgeVoxtralSession } from "./voxtral-session.js";

export function bridgeSession(args) {
  if (args.config.backend === "voxtral") {
    bridgeVoxtralSession(args);
    return;
  }

  bridgeVllmSession(args);
}
