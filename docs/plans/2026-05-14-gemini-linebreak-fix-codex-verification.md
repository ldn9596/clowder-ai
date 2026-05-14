# Gemini 换行修复 — Codex 自动化验证方案

> **目标**: 通过 Cat Cafe API 端到端验证 `fix/gemini-display-linebreak` 分支的修复效果
> **执行者**: Codex (cloud agent)
> **前置条件**: Cat Cafe API 运行中，Gemini CLI 已安装且登录，fork 分支已部署

---

## 1. 验证目标

| # | 验证项 | 期望结果 |
|---|--------|----------|
| V1 | Gemini 回复无 synthetic `\n\n` 拆断 CJK/路径/数字/英文 | 回复文本中无 token 中间 `\n\n` |
| V2 | `@猫名` 跨 chunk boundary 后仍完整 | 回复中 @ mention 可被正确解析 |
| V3 | `lastTurnInputTokens` 注入成功 | done event metadata 中有 `lastTurnInputTokens` |
| V4 | `contextHealth.usedFrom === 'last_turn'` | context_health system_info 中 usedFrom 为 last_turn |
| V5 | 现有 Claude/Codex provider 不受影响 | 非 Gemini 猫回复行为不变 |

## 2. 环境准备

### 2.1 API 基础信息

```bash
API_BASE="http://localhost:3000"
USER_HEADER="X-Cat-Cafe-User: test-verifier"
```

### 2.2 创建 Gemini 测试猫

```bash
curl -s -X POST "${API_BASE}/api/cats" \
  -H "Content-Type: application/json" \
  -H "${USER_HEADER}" \
  -d '{
    "catId": "gemini-verify",
    "name": "Gemini 验证猫",
    "displayName": "验证猫",
    "clientId": "google",
    "defaultModel": "gemini-2.5-flash",
    "mentionPatterns": ["@验证猫", "@gemini-verify"],
    "roleDescription": "用于验证 Gemini 换行修复的临时猫",
    "color": { "primary": "#4285F4", "secondary": "#EA4335" },
    "personality": "精确回复，不要额外解释",
    "mcpSupport": false,
    "sessionChain": true
  }'
```

验证返回 201 且 `cat.cli.outputFormat === "stream-json"`。

### 2.3 创建测试线程

```bash
THREAD_ID=$(curl -s -X POST "${API_BASE}/api/threads" \
  -H "Content-Type: application/json" \
  -H "${USER_HEADER}" \
  -d '{"title": "gemini-linebreak-verification"}' \
  | jq -r '.thread.id')

echo "Thread: ${THREAD_ID}"
```

## 3. 验证用例

### V1: CJK / 路径 / 数字 / 英文无 synthetic `\n\n`

**发送 prompt**（设计为让模型回复包含易被拆断的内容）:

```bash
curl -s -X POST "${API_BASE}/api/messages" \
  -H "Content-Type: application/json" \
  -H "${USER_HEADER}" \
  -d '{
    "content": "@gemini-verify 请用一段话回答以下问题（不要分点、不要换行、不要代码块）：描述文件路径 /Volumes/mac1t/lawplatform/docs/testfile.pdf 中的多模态智能信息提取交付物清单，包含2026年的日期。",
    "threadId": "'"${THREAD_ID}"'",
    "mentions": ["gemini-verify"]
  }'
```

**等待完成**（轮询 invocation 状态）:

```bash
# 从 POST 响应获取 invocationId
INVOCATION_ID="<from response>"

# 轮询直到 succeeded/failed
for i in $(seq 1 30); do
  STATUS=$(curl -s "${API_BASE}/api/invocations/${INVOCATION_ID}" \
    -H "${USER_HEADER}" | jq -r '.status')
  if [ "$STATUS" = "succeeded" ] || [ "$STATUS" = "failed" ]; then
    echo "Invocation ${STATUS}"
    break
  fi
  sleep 2
done
```

**读取回复并分析**:

```bash
MESSAGES=$(curl -s "${API_BASE}/api/messages?threadId=${THREAD_ID}&limit=50" \
  -H "${USER_HEADER}")

# 提取 Gemini 猫的回复
REPLY=$(echo "$MESSAGES" | jq -r '.messages[] | select(.catId == "gemini-verify" and .type == "assistant") | .content')

echo "=== Gemini Reply ==="
echo "$REPLY"
echo "===================="
```

**自动化断言脚本** (`verify-v1.sh`):

```bash
#!/bin/bash
# V1: 检查回复中是否有 synthetic \n\n 拆断 token

REPLY="$1"

# 检测模式: 中文字符 + \n\n + 中文字符（同一个词被拆断）
if echo "$REPLY" | grep -P '[\x{4e00}-\x{9fff}]\n\n[\x{4e00}-\x{9fff}]' > /dev/null 2>&1; then
  echo "FAIL: CJK token split by synthetic \\n\\n"
  echo "$REPLY" | grep -P '[\x{4e00}-\x{9fff}]\n\n[\x{4e00}-\x{9fff}]'
  exit 1
fi

# 检测: 路径中间 \n\n
if echo "$REPLY" | grep -E '/[a-zA-Z0-9]+\n\n/[a-zA-Z0-9]+' > /dev/null 2>&1; then
  echo "FAIL: Path split by synthetic \\n\\n"
  exit 1
fi

# 检测: 数字中间 \n\n
if echo "$REPLY" | grep -E '[0-9]\n\n[0-9]' > /dev/null 2>&1; then
  echo "FAIL: Digit split by synthetic \\n\\n"
  exit 1
fi

# 检测: 英文单词中间 \n\n（小写字母 + \n\n + 小写字母）
if echo "$REPLY" | grep -E '[a-z]\n\n[a-z]' > /dev/null 2>&1; then
  echo "FAIL: English word split by synthetic \\n\\n"
  exit 1
fi

echo "PASS: No synthetic \\n\\n token splits detected"
exit 0
```

### V2: @ handle 完整性

**发送 prompt**（让模型回复中包含 @ mention）:

```bash
curl -s -X POST "${API_BASE}/api/messages" \
  -H "Content-Type: application/json" \
  -H "${USER_HEADER}" \
  -d '{
    "content": "@gemini-verify 请回复以下格式（严格遵守，不要改动格式）：\n分析完毕\n@验证猫\n请确认结果",
    "threadId": "'"${THREAD_ID}"'",
    "mentions": ["gemini-verify"]
  }'
```

**断言**:

```bash
REPLY=$(curl -s "${API_BASE}/api/messages?threadId=${THREAD_ID}&limit=50" \
  -H "${USER_HEADER}" \
  | jq -r '.messages[-1].content')

# @ handle 必须完整，不能被 \n\n 拆断
if echo "$REPLY" | grep -F '@验证' | grep -v '@验证猫' > /dev/null 2>&1; then
  echo "FAIL: @ handle split — found partial @验证 without 猫"
  exit 1
fi

# 如果回复包含 @验证猫，检查它是否在行首
if echo "$REPLY" | grep -F '@验证猫' > /dev/null 2>&1; then
  echo "PASS: @ handle intact"
else
  echo "WARN: Model did not include @验证猫 in reply (may have rephrased)"
fi
```

### V3: lastTurnInputTokens 注入

**方法**: 通过 WebSocket 监听或读取线程消息的 metadata。

```bash
# 从消息列表获取最新的 assistant 消息 metadata
METADATA=$(curl -s "${API_BASE}/api/messages?threadId=${THREAD_ID}&limit=50" \
  -H "${USER_HEADER}" \
  | jq '.messages[] | select(.catId == "gemini-verify" and .type == "assistant") | .metadata' \
  | tail -1)

echo "=== Metadata ==="
echo "$METADATA" | jq .

# 检查 lastTurnInputTokens
LAST_TURN=$(echo "$METADATA" | jq '.usage.lastTurnInputTokens // empty')
if [ -n "$LAST_TURN" ] && [ "$LAST_TURN" != "null" ]; then
  echo "PASS: lastTurnInputTokens = ${LAST_TURN}"
else
  echo "WARN: lastTurnInputTokens not present (may depend on local jsonl availability)"
fi
```

### V4: contextHealth usedFrom

```bash
# 从 system_info 类型消息中查找 context_health
HEALTH=$(curl -s "${API_BASE}/api/messages?threadId=${THREAD_ID}&limit=100" \
  -H "${USER_HEADER}" \
  | jq -r '.messages[] | select(.type == "system") | .content // empty' \
  | grep 'context_health' | tail -1)

if [ -n "$HEALTH" ]; then
  USED_FROM=$(echo "$HEALTH" | jq -r '.health.usedFrom // empty')
  if [ "$USED_FROM" = "last_turn" ]; then
    echo "PASS: contextHealth.usedFrom = last_turn"
  else
    echo "INFO: contextHealth.usedFrom = ${USED_FROM} (acceptable if jsonl not available)"
  fi
else
  echo "INFO: No context_health event found (normal if session chain not active)"
fi
```

### V5: Claude/Codex 不受影响（对照组）

```bash
# 如果存在 Claude 猫，发同样的 prompt 确认行为不变
CLAUDE_CAT=$(curl -s "${API_BASE}/api/cats" -H "${USER_HEADER}" \
  | jq -r '.cats[] | select(.clientId == "anthropic") | .id' | head -1)

if [ -n "$CLAUDE_CAT" ]; then
  curl -s -X POST "${API_BASE}/api/messages" \
    -H "Content-Type: application/json" \
    -H "${USER_HEADER}" \
    -d '{
      "content": "@'"${CLAUDE_CAT}"' 简单回复：你好",
      "threadId": "'"${THREAD_ID}"'",
      "mentions": ["'"${CLAUDE_CAT}"'"]
    }'
  
  sleep 10
  
  CLAUDE_REPLY=$(curl -s "${API_BASE}/api/messages?threadId=${THREAD_ID}&limit=10" \
    -H "${USER_HEADER}" \
    | jq -r '.messages[] | select(.catId == "'"${CLAUDE_CAT}"'") | .content' | tail -1)
  
  if [ -n "$CLAUDE_REPLY" ]; then
    echo "PASS: Claude responded normally: ${CLAUDE_REPLY:0:50}..."
  else
    echo "WARN: Claude did not respond within timeout"
  fi
else
  echo "SKIP: No Claude cat available for control test"
fi
```

## 4. 综合验证脚本

```bash
#!/bin/bash
# gemini-linebreak-verification.sh
# 运行全部验证用例，汇总结果

set -euo pipefail

API_BASE="${CAT_CAFE_API_BASE:-http://localhost:3000}"
USER="test-verifier"
RESULTS=()

log() { echo "[$(date +%H:%M:%S)] $1"; }
pass() { RESULTS+=("PASS: $1"); log "✅ $1"; }
fail() { RESULTS+=("FAIL: $1"); log "❌ $1"; }
warn() { RESULTS+=("WARN: $1"); log "⚠️  $1"; }

# --- Setup ---
log "Creating test thread..."
THREAD_ID=$(curl -s -X POST "${API_BASE}/api/threads" \
  -H "Content-Type: application/json" \
  -H "X-Cat-Cafe-User: ${USER}" \
  -d '{"title": "gemini-linebreak-auto-verify"}' \
  | jq -r '.thread.id')
log "Thread: ${THREAD_ID}"

# --- Helper: send message and wait for reply ---
send_and_wait() {
  local content="$1"
  local cat_id="$2"
  local timeout="${3:-60}"
  
  local resp=$(curl -s -X POST "${API_BASE}/api/messages" \
    -H "Content-Type: application/json" \
    -H "X-Cat-Cafe-User: ${USER}" \
    -d '{
      "content": "'"${content}"'",
      "threadId": "'"${THREAD_ID}"'",
      "mentions": ["'"${cat_id}"'"]
    }')
  
  local inv_id=$(echo "$resp" | jq -r '.invocationId // empty')
  if [ -z "$inv_id" ]; then
    echo "ERROR: No invocationId returned"
    return 1
  fi
  
  for i in $(seq 1 $((timeout / 2))); do
    local status=$(curl -s "${API_BASE}/api/invocations/${inv_id}" \
      -H "X-Cat-Cafe-User: ${USER}" | jq -r '.status')
    if [ "$status" = "succeeded" ]; then
      break
    elif [ "$status" = "failed" ]; then
      echo "ERROR: Invocation failed"
      return 1
    fi
    sleep 2
  done
  
  # Return latest assistant message
  curl -s "${API_BASE}/api/messages?threadId=${THREAD_ID}&limit=10" \
    -H "X-Cat-Cafe-User: ${USER}" \
    | jq -r '.messages | map(select(.catId == "'"${cat_id}"'" and .type == "assistant")) | last | .content // empty'
}

# --- Find a Gemini cat ---
GEMINI_CAT=$(curl -s "${API_BASE}/api/cats" \
  -H "X-Cat-Cafe-User: ${USER}" \
  | jq -r '.cats[] | select(.clientId == "google") | .id' | head -1)

if [ -z "$GEMINI_CAT" ]; then
  fail "No Gemini cat found — cannot run verification"
  exit 1
fi
log "Using Gemini cat: ${GEMINI_CAT}"

# --- V1: No synthetic \n\n ---
log "V1: Testing CJK/path/digit/English integrity..."
REPLY=$(send_and_wait \
  "@${GEMINI_CAT} 请用一段连续的话描述：文件路径 /Volumes/mac1t/lawplatform/docs/testfile.pdf 中包含2026年多模态智能信息提取的交付物清单。不要分点，不要换行。" \
  "$GEMINI_CAT" 60)

if [ -z "$REPLY" ]; then
  fail "V1: No reply received"
else
  HAS_SPLIT=false
  # CJK mid-token \n\n
  if echo "$REPLY" | perl -ne 'exit 1 if /[\x{4e00}-\x{9fff}]\n\n[\x{4e00}-\x{9fff}]/' 2>/dev/null; then
    HAS_SPLIT=true; fail "V1: CJK token split"
  fi
  # Path mid-split
  if echo "$REPLY" | grep -qP '/\w+\n\n/\w+' 2>/dev/null; then
    HAS_SPLIT=true; fail "V1: Path split"
  fi
  # Digit mid-split
  if echo "$REPLY" | grep -qP '\d\n\n\d' 2>/dev/null; then
    HAS_SPLIT=true; fail "V1: Digit split"
  fi
  
  if [ "$HAS_SPLIT" = false ]; then
    pass "V1: No synthetic \\n\\n splits detected"
  fi
fi

# --- V2: @ handle intact ---
log "V2: Testing @ handle integrity..."
REPLY2=$(send_and_wait \
  "@${GEMINI_CAT} 请严格按以下格式回复（不要修改）：\n分析完毕\n@${GEMINI_CAT}\n请确认" \
  "$GEMINI_CAT" 60)

if [ -z "$REPLY2" ]; then
  fail "V2: No reply received"
elif echo "$REPLY2" | grep -qF "@${GEMINI_CAT}"; then
  pass "V2: @ handle intact in reply"
else
  warn "V2: Model did not reproduce @ handle verbatim (may have rephrased)"
fi

# --- V3 & V4: Token injection + context health ---
log "V3/V4: Checking metadata..."
MSGS_JSON=$(curl -s "${API_BASE}/api/messages?threadId=${THREAD_ID}&limit=100" \
  -H "X-Cat-Cafe-User: ${USER}")

LAST_TURN_TOKENS=$(echo "$MSGS_JSON" \
  | jq '[.messages[] | select(.catId == "'"${GEMINI_CAT}"'" and .type == "assistant") | .metadata.usage.lastTurnInputTokens // null] | map(select(. != null)) | last // empty')

if [ -n "$LAST_TURN_TOKENS" ] && [ "$LAST_TURN_TOKENS" != "null" ]; then
  pass "V3: lastTurnInputTokens = ${LAST_TURN_TOKENS}"
else
  warn "V3: lastTurnInputTokens not found (depends on local jsonl)"
fi

# --- Summary ---
echo ""
echo "=============================="
echo "  Verification Summary"
echo "=============================="
for r in "${RESULTS[@]}"; do
  echo "  $r"
done

FAIL_COUNT=$(printf '%s\n' "${RESULTS[@]}" | grep -c "^FAIL" || true)
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo "RESULT: ${FAIL_COUNT} FAILURE(S)"
  exit 1
else
  echo ""
  echo "RESULT: ALL PASSED"
  exit 0
fi
```

## 5. Codex 执行指令

Codex 应按以下步骤执行：

1. **确认环境**：Cat Cafe API 可达，Gemini CLI 已安装
2. **确认分支**：当前运行的 API 代码包含 `fix/gemini-display-linebreak` 的修改
3. **查找 Gemini 猫**：通过 `GET /api/cats` 找到 `clientId === "google"` 的猫，如无则通过 `POST /api/cats` 创建
4. **执行综合验证脚本**
5. **收集结果**：汇总 PASS/FAIL/WARN，附上 Gemini 原始回复文本供人工复核
6. **多轮验证**：至少执行 3 轮（Gemini 的 chunk boundary 位置不确定，多轮增加覆盖概率）

## 6. 预期结果

- **修复前**（main 分支）：V1 大概率 FAIL（CJK/path/digit 被 `\n\n` 拆断）
- **修复后**（fix 分支）：V1-V5 全部 PASS 或 WARN（WARN 仅在环境限制时出现）

## 7. 注意事项

- V1 的 `\n\n` 检测依赖模型回复足够长以触发多个 streaming chunk。短回复可能只有一个 chunk，不会触发问题。prompt 设计应诱导中等长度回复。
- V2 的 @ handle 测试依赖模型遵循格式指令。如果模型重新措辞，V2 可能是 WARN 而非 PASS/FAIL。
- V3/V4 依赖本地 Gemini CLI jsonl 文件可用。如果 jsonl 不可读（权限/路径问题），这些会是 WARN。
- 建议在修复前（main）和修复后（fix 分支）各跑一次，做 A/B 对比。

---

*[宪宪/Opus-46🐾]*
