#!/bin/bash
# Ascend NPU Single-Node Environment Check
# Usage: bash check.sh

set -euo pipefail

# ─── Config ───

CMD_TIMEOUT=10
OUTPUT_DIR="./output"
NOW=$(date +%Y%m%d_%H%M%S)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
HOSTNAME=$(hostname)
OUTPUT_FILE="${OUTPUT_DIR}/npu_check_${NOW}.json"

PASSED=0
FAILED=0
WARNINGS=0
TOTAL=0
CHECKS_JSON=""

# ─── Helpers ───

json_escape() {
  # Minimal JSON string escape: backslash, double-quote, newline
  sed 's/\\/\\\\/g; s/"/\\"/g' <<< "$1" | tr '\n' ' '
}

check_result() {
  local status="$1" msg="$2"
  TOTAL=$((TOTAL + 1))
  case "$status" in
    PASS|INFO|N/A) PASSED=$((PASSED + 1)) ;;
    FAIL|ERROR)    FAILED=$((FAILED + 1)) ;;
    WARN)          WARNINGS=$((WARNINGS + 1)) ;;
  esac
  local escaped
  escaped=$(json_escape "$msg")
  CHECKS_JSON+=$(printf '{"status":"%s","message":"%s"},' "$status" "$escaped")
}

# ─── Phase 1: npu-smi availability ───

echo "══════════════════════════════════════════════"
echo "  Ascend NPU Single-Node Environment Check"
echo "  ${TIMESTAMP} | hostname: ${HOSTNAME}"
echo "══════════════════════════════════════════════"
echo ""
echo "── Driver & Firmware ──"

if ! command -v npu-smi &>/dev/null; then
  echo "[FAIL] npu-smi not found — is CANN installed?"
  check_result "FAIL" "npu-smi not found — is CANN installed?"

  # Abort — no npu-smi means no further checks possible
  SUMMARY_JSON=$(printf '{"total":%d,"passed":%d,"failed":%d,"warnings":%d}' "$TOTAL" "$PASSED" "$FAILED" "$WARNINGS")
  REPORT_JSON=$(cat <<JSON_END
{
  "meta": {"timestamp":"$TIMESTAMP","hostname":"$HOSTNAME"},
  "summary": $SUMMARY_JSON,
  "checks": {
    "driver": {
      "available": {"status":"FAIL","message":"npu-smi not found — is CANN installed?"},
      "driver_version": {"status":"N/A","message":"Skipped: npu-smi not available"},
      "firmware_version": {"status":"N/A","message":"Skipped: npu-smi not available"}
    },
    "hardware": {
      "chip_count": 0,
      "chips": [],
      "overall": {"status":"N/A","message":"Skipped: npu-smi not available"}
    },
    "network": {
      "p2p": {"status":"N/A","message":"Skipped: npu-smi not available"},
      "roce": {"status":"N/A","message":"Skipped: npu-smi not available"},
      "overall": {"status":"N/A","message":"Skipped: npu-smi not available"}
    }
  }
}
JSON_END
)

  mkdir -p "$OUTPUT_DIR"
  echo "$REPORT_JSON" > "$OUTPUT_FILE"
  echo ""
  echo "──────────────────────────────────────────────"
  echo "  Summary: 0 passed / 1 failed / 0 warning"
  echo ""
  echo "Report saved to: $OUTPUT_FILE"
  echo ""
  echo "── JSON Report ──"
  echo "$REPORT_JSON"
  exit 1
fi

echo "[PASS] npu-smi is available"
check_result "PASS" "npu-smi is available"

# ─── Phase 2: Board info ───

BOARD_OUT=$(npu-smi info -t board -i 0 2>/dev/null || true)

DRIVER_VERSION=$(echo "$BOARD_OUT" | grep -E '^\s*DRIVER Version\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)
if [ -z "$DRIVER_VERSION" ]; then
  DRIVER_VERSION=$(echo "$BOARD_OUT" | grep -E '^\s*Driver Version\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)
fi

FIRMWARE_VERSION=$(echo "$BOARD_OUT" | grep -E '^\s*Firmware Version\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)
CHIP_COUNT=$(echo "$BOARD_OUT" | grep -E '^\s*Chip Count\s*:' | head -1 | sed 's/.*:\s*//' | xargs || echo "0")

if [ -n "$DRIVER_VERSION" ]; then
  echo "[PASS] Driver: ${DRIVER_VERSION}"
  check_result "PASS" "Driver: ${DRIVER_VERSION}"
else
  echo "[FAIL] Driver version not found in npu-smi output"
  check_result "FAIL" "Driver version not found in npu-smi output"
fi

if [ -n "$FIRMWARE_VERSION" ]; then
  echo "[PASS] Firmware: ${FIRMWARE_VERSION}"
  check_result "PASS" "Firmware: ${FIRMWARE_VERSION}"
else
  echo "[FAIL] Firmware version not found in npu-smi output"
  check_result "FAIL" "Firmware version not found in npu-smi output"
fi

# ─── Phase 3: Per-chip hardware ───

echo ""
echo "── Hardware (${CHIP_COUNT} chip(s)) ──"

CHIPS_JSON=""
UNHEALTHY=0

for ((chip=0; chip<CHIP_COUNT; chip++)); do
  USAGE_OUT=$(npu-smi info -t usages -i "$chip" 2>/dev/null || true)
  MEM_OUT=$(npu-smi info -t memory -i "$chip" 2>/dev/null || true)

  # Extract fields
  TEMP=$(echo "$USAGE_OUT" | grep -E '^\s*Temperature\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)
  POWER=$(echo "$USAGE_OUT" | grep -E '^\s*Power\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)
  AI_CORE=$(echo "$USAGE_OUT" | grep -E '^\s*AI Core Usage\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)
  CHIP_HEALTH=$(echo "$USAGE_OUT" | grep -E '^\s*Health\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)

  MEM_TOTAL=$(echo "$MEM_OUT" | grep -E '^\s*Memory Total\(MB\)\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)
  MEM_USED=$(echo "$MEM_OUT" | grep -E '^\s*Memory Used\(MB\)\s*:' | head -1 | sed 's/.*:\s*//' | xargs || true)

  # Health verdict
  HEALTH_STATUS="PASS"
  HEALTH_MSG="OK"
  if [ -z "$CHIP_HEALTH" ] || [ "$CHIP_HEALTH" = "OK" ]; then
    HEALTH_MSG="OK"
  else
    HEALTH_STATUS="FAIL"
    HEALTH_MSG="$CHIP_HEALTH"
    UNHEALTHY=$((UNHEALTHY + 1))
  fi

  # Build display line
  DISPLAY="Chip ${chip}: [${HEALTH_STATUS}] health=${HEALTH_MSG}"
  [ -n "$TEMP" ]    && DISPLAY="${DISPLAY} | temp=${TEMP}°C"
  [ -n "$POWER" ]   && DISPLAY="${DISPLAY} | power=${POWER}W"
  [ -n "$AI_CORE" ] && DISPLAY="${DISPLAY} | ai_core=${AI_CORE}%"

  if [ -n "$MEM_TOTAL" ] && [ -n "$MEM_USED" ]; then
    TOTAL_GB=$(awk "BEGIN {printf \"%.1f\", ${MEM_TOTAL}/1024}")
    USED_GB=$(awk "BEGIN {printf \"%.1f\", ${MEM_USED}/1024}")
    DISPLAY="${DISPLAY} | mem=${USED_GB}/${TOTAL_GB} GB"
  fi

  echo "  ${DISPLAY}"

  # Append to chips JSON array
  TEMP_JSON="null"; [ -n "$TEMP" ] && TEMP_JSON="$TEMP"
  POWER_JSON="null"; [ -n "$POWER" ] && POWER_JSON="$POWER"
  AI_CORE_JSON="null"; [ -n "$AI_CORE" ] && AI_CORE_JSON="$AI_CORE"
  MEM_TOTAL_JSON="null"; [ -n "$MEM_TOTAL" ] && MEM_TOTAL_JSON="$MEM_TOTAL"
  MEM_USED_JSON="null"; [ -n "$MEM_USED" ] && MEM_USED_JSON="$MEM_USED"

  HEALTH_MSG_ESC=$(json_escape "$HEALTH_MSG")
  CHIPS_JSON+=$(cat <<CHIP_END
{
  "id": $chip,
  "health": {"status":"$HEALTH_STATUS","message":"$HEALTH_MSG_ESC"},
  "temperature": $TEMP_JSON,
  "power": $POWER_JSON,
  "ai_core_usage": $AI_CORE_JSON,
  "memory_total_mb": $MEM_TOTAL_JSON,
  "memory_used_mb": $MEM_USED_JSON
},
CHIP_END
  )
done

# Remove trailing comma from chips array
CHIPS_JSON="${CHIPS_JSON%,}"

if [ "$CHIP_COUNT" -eq 0 ]; then
  echo "[FAIL] No NPU chips detected"
  HW_OVERALL='{"status":"FAIL","message":"No NPU chips detected"}'
  check_result "FAIL" "No NPU chips detected"
elif [ "$UNHEALTHY" -eq 0 ]; then
  echo "[PASS] Hardware overall: All ${CHIP_COUNT} chip(s) healthy"
  HW_OVERALL="{\"status\":\"PASS\",\"message\":\"All ${CHIP_COUNT} chip(s) healthy\"}"
  check_result "PASS" "All ${CHIP_COUNT} chip(s) healthy"
else
  echo "[FAIL] Hardware overall: ${UNHEALTHY} chip(s) report issues"
  HW_OVERALL="{\"status\":\"FAIL\",\"message\":\"${UNHEALTHY} chip(s) report issues\"}"
  check_result "FAIL" "${UNHEALTHY} chip(s) report issues"
fi

# ─── Phase 4: Network ───

echo ""
echo "── Network ──"

P2P_OUT=$(npu-smi info -t p2p -i 0 2>/dev/null || true)
if [ -n "${P2P_OUT:-}" ] && [ "$(echo "$P2P_OUT" | tr -d '[:space:]')" != "" ]; then
  echo "[PASS] P2P: connectivity data available"
  P2P_JSON='{"status":"PASS","message":"P2P connectivity data available"}'
  check_result "PASS" "P2P connectivity data available"
else
  echo "[ N/A] P2P: no connectivity data returned"
  P2P_JSON='{"status":"N/A","message":"P2P: no connectivity data returned"}'
  check_result "N/A" "P2P: no connectivity data returned"
fi

if command -v ibstat &>/dev/null; then
  ROCE_FIRST_LINE=$(ibstat 2>/dev/null | head -1 | xargs || echo "ibstat ok")
  echo "[PASS] RoCE/IB available: ${ROCE_FIRST_LINE}"
  ROCE_MSG_ESC=$(json_escape "RoCE/IB available: ${ROCE_FIRST_LINE}")
  ROCE_JSON="{\"status\":\"PASS\",\"message\":\"${ROCE_MSG_ESC}\"}"
  check_result "PASS" "RoCE/IB available"
else
  echo "[ N/A] RoCE: ibstat not found — no RoCE/IB NIC detected"
  ROCE_JSON='{"status":"N/A","message":"ibstat not found — no RoCE/IB NIC detected"}'
  check_result "N/A" "ibstat not found — no RoCE/IB NIC detected"
fi

if command -v ibstat &>/dev/null; then
  NET_OVERALL='{"status":"PASS","message":"Network checks OK"}'
else
  NET_OVERALL='{"status":"N/A","message":"Network checks incomplete"}'
fi

# ─── Build report ───

CHECKS_JSON="${CHECKS_JSON%,}"  # remove trailing comma from check results array

SUMMARY_JSON=$(printf '{"total":%d,"passed":%d,"failed":%d,"warnings":%d}' "$TOTAL" "$PASSED" "$FAILED" "$WARNINGS")

DRIVER_AVAIL_ESC=$(json_escape "npu-smi is available")
DRIVER_VER_ESC=$(json_escape "$DRIVER_VERSION")
FW_VER_ESC=$(json_escape "$FIRMWARE_VERSION")

if [ -n "$DRIVER_VERSION" ]; then
  DRV_JSON="{\"status\":\"PASS\",\"message\":\"${DRIVER_VER_ESC}\"}"
else
  DRV_JSON='{"status":"FAIL","message":"Driver version not found in npu-smi output"}'
fi

if [ -n "$FIRMWARE_VERSION" ]; then
  FW_JSON="{\"status\":\"PASS\",\"message\":\"${FW_VER_ESC}\"}"
else
  FW_JSON='{"status":"FAIL","message":"Firmware version not found in npu-smi output"}'
fi

REPORT_JSON=$(cat <<JSON_END
{
  "meta": {"timestamp":"$TIMESTAMP","hostname":"$HOSTNAME"},
  "summary": $SUMMARY_JSON,
  "checks": {
    "driver": {
      "available": {"status":"PASS","message":"$DRIVER_AVAIL_ESC"},
      "driver_version": $DRV_JSON,
      "firmware_version": $FW_JSON
    },
    "hardware": {
      "chip_count": $CHIP_COUNT,
      "chips": [$CHIPS_JSON],
      "overall": $HW_OVERALL
    },
    "network": {
      "p2p": $P2P_JSON,
      "roce": $ROCE_JSON,
      "overall": $NET_OVERALL
    }
  }
}
JSON_END
)

# ─── Save report ───

mkdir -p "$OUTPUT_DIR"
if echo "$REPORT_JSON" > "$OUTPUT_FILE" 2>/dev/null; then
  SAVE_MSG="Report saved to: $OUTPUT_FILE"
else
  SAVE_MSG="⚠ Report could not be saved to file."
fi

echo ""
echo "──────────────────────────────────────────────"
echo "  Summary: ${PASSED} passed / ${FAILED} failed / ${WARNINGS} warning"
echo ""
echo "$SAVE_MSG"
echo ""
echo "── JSON Report ──"
echo "$REPORT_JSON"
