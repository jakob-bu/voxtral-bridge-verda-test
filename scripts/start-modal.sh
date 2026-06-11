#!/usr/bin/env bash
set -euo pipefail

MODEL_ID="${MODEL_ID:-mistralai/Voxtral-Mini-4B-Realtime-2602}"
VLLM_HOST="${VLLM_HOST:-127.0.0.1}"
VLLM_PORT="${VLLM_PORT:-8000}"
BRIDGE_HOST="${BRIDGE_HOST:-0.0.0.0}"
BRIDGE_PORT="${BRIDGE_PORT:-8787}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-50000}"
VLLM_HEALTH_WAIT_SECONDS="${VLLM_HEALTH_WAIT_SECONDS:-1800}"
VLLM_COMPILATION_CONFIG="${VLLM_COMPILATION_CONFIG:-}"
VLLM_ENFORCE_EAGER="${VLLM_ENFORCE_EAGER:-0}"
VLLM_WS_URL="ws://${VLLM_HOST}:${VLLM_PORT}/v1/realtime"

if [[ -z "${VLLM_COMPILATION_CONFIG}" ]]; then
  VLLM_COMPILATION_CONFIG='{"cudagraph_mode":"PIECEWISE"}'
fi

resolve_vllm_python() {
  local vllm_bin shebang runner
  vllm_bin="$(command -v vllm)"
  shebang="$(head -n 1 "${vllm_bin}")"
  shebang="${shebang#\#!}"

  if [[ "${shebang}" == /usr/bin/env* ]]; then
    runner="${shebang##* }"
    command -v "${runner}"
  else
    printf "%s\n" "${shebang}"
  fi
}

ensure_audio_deps() {
  local py_bin="$1"
  if ! "${py_bin}" - <<'PY' >/dev/null 2>&1
import importlib
importlib.import_module("mistral_common")
importlib.import_module("soundfile")
PY
  then
    echo "[modal-voxtral] installing audio deps into ${py_bin}"
    "${py_bin}" -m pip install --no-cache-dir "mistral_common[soundfile]>=1.9.0"
  fi
}

VLLM_PYTHON="$(resolve_vllm_python)"
ensure_audio_deps "${VLLM_PYTHON}"

echo "[modal-voxtral] starting vLLM on ${VLLM_HOST}:${VLLM_PORT} with model ${MODEL_ID}"

VLLM_ARGS=(
  serve
  "${MODEL_ID}"
  --host "${VLLM_HOST}"
  --port "${VLLM_PORT}"
  --max-model-len "${MAX_MODEL_LEN}"
  --compilation_config "${VLLM_COMPILATION_CONFIG}"
)

if [[ "${VLLM_ENFORCE_EAGER}" == "1" ]]; then
  VLLM_ARGS+=(--enforce-eager)
fi

if [[ -n "${VLLM_API_KEY:-}" ]]; then
  VLLM_ARGS+=(--api-key "${VLLM_API_KEY}")
fi

vllm "${VLLM_ARGS[@]}" &
VLLM_PID=$!

cleanup() {
  if kill -0 "${VLLM_PID}" >/dev/null 2>&1; then
    kill "${VLLM_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

READY=0
for ((i = 1; i <= VLLM_HEALTH_WAIT_SECONDS; i++)); do
  if curl -fsS "http://${VLLM_HOST}:${VLLM_PORT}/health" >/dev/null 2>&1; then
    READY=1
    break
  fi

  if ! kill -0 "${VLLM_PID}" >/dev/null 2>&1; then
    echo "[modal-voxtral] vLLM exited before health check completed"
    wait "${VLLM_PID}" || true
    exit 1
  fi

  sleep 1
done

if [[ "${READY}" != "1" ]]; then
  echo "[modal-voxtral] vLLM did not become healthy within ${VLLM_HEALTH_WAIT_SECONDS}s"
  exit 1
fi

echo "[modal-voxtral] vLLM healthy; starting bridge on ${BRIDGE_HOST}:${BRIDGE_PORT}"

export BACKEND=vllm
export HOST="${BRIDGE_HOST}"
export PORT="${BRIDGE_PORT}"
export VLLM_REALTIME_URL="${VLLM_WS_URL}"

if [[ -n "${VLLM_API_KEY:-}" ]]; then
  export VLLM_API_KEY="${VLLM_API_KEY}"
fi

exec node src/index.js
