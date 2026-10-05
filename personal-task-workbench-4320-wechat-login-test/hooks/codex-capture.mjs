import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultQueue = resolve(scriptDir, "..", "data", "codex-events.jsonl");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function redactSecrets(value) {
  if (!value) return "";
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[已遮盖的 OpenAI 密钥]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[已遮盖的 GitHub 令牌]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [已遮盖]")
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[已遮盖]",
    );
}

function stableId(payload, kind) {
  const session = payload.session_id || "unknown-session";
  const turn = payload.turn_id || Date.now();
  return `${session}:${turn}:${kind}`;
}

let payload = {};
let raw = "";

try {
  for await (const chunk of process.stdin) raw += chunk;
  payload = raw ? JSON.parse(raw) : {};

  const eventName = payload.hook_event_name || "Unknown";
  let kind = "";
  let content = "";

  if (eventName === "UserPromptSubmit") {
    kind = "user_prompt";
    content = payload.prompt || "";
  } else if (eventName === "Stop") {
    kind = "assistant_result";
    content = payload.last_assistant_message || "";
  }

  if (kind && content.trim()) {
    const queuePath = resolve(argValue("--queue") || defaultQueue);
    mkdirSync(dirname(queuePath), { recursive: true });
    const event = {
      id: stableId(payload, kind),
      kind,
      content: redactSecrets(content.trim()),
      occurredAt: new Date().toISOString(),
      sessionId: payload.session_id || "",
      turnId: payload.turn_id || "",
      cwd: payload.cwd || "",
      model: payload.model || "",
      transcriptPath: payload.transcript_path || "",
    };
    appendFileSync(queuePath, `${JSON.stringify(event)}\n`, "utf8");
  }
} catch (error) {
  try {
    const errorPath = resolve(scriptDir, "..", "data", "hook-errors.log");
    mkdirSync(dirname(errorPath), { recursive: true });
    appendFileSync(
      errorPath,
      `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`,
      "utf8",
    );
  } catch {
    // The capture hook must never interrupt the user's Codex turn.
  }
}

process.stdout.write(JSON.stringify({ continue: true }));
