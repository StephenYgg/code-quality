#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const fixturePath = fileURLToPath(import.meta.url);
const fixtureDirectory = dirname(fixturePath);
const isVersionProbe = args.includes("--version") || args.includes("-V");
const isHelpProbe = args.includes("--help") || args.includes("-h");
const probeModePath = join(fixtureDirectory, "probe-mode.txt");
const probeMode = existsSync(probeModePath)
  ? readFileSync(probeModePath, "utf8").trim()
  : undefined;
let firstVersionHang = false;
if (probeMode === "first-version-hang-then-ok" && isVersionProbe) {
  const attemptsPath = join(fixtureDirectory, "probe-attempt-count.txt");
  const attempts = existsSync(attemptsPath)
    ? Number.parseInt(readFileSync(attemptsPath, "utf8"), 10) || 0
    : 0;
  writeFileSync(attemptsPath, `${String(attempts + 1)}\n`, "utf8");
  firstVersionHang = attempts === 0;
}

if (
  (probeMode === "hang-ignore-sigterm" && (isVersionProbe || isHelpProbe)) ||
  (probeMode === "version-stream-ignore-sigterm" && isVersionProbe) ||
  firstVersionHang
) {
  writeFileSync(
    join(fixtureDirectory, "probe.pid"),
    `${String(process.pid)}\n`,
    "utf8",
  );
  process.on("SIGTERM", () => {
    if (firstVersionHang) {
      writeFileSync(
        join(fixtureDirectory, "probe.sigterm"),
        "received\n",
        "utf8",
      );
    }
  });
  if (probeMode === "version-stream-ignore-sigterm") {
    const chunk = "v".repeat(8 * 1024);
    process.stdout.write(chunk);
    setInterval(() => process.stdout.write(chunk), 5);
  } else {
    setInterval(() => undefined, 60_000);
  }
  await new Promise(() => undefined);
}

if (isVersionProbe) {
  const countPath = join(fixtureDirectory, "version-count.txt");
  if (existsSync(countPath)) {
    const count = Number.parseInt(readFileSync(countPath, "utf8"), 10) || 0;
    writeFileSync(countPath, `${String(count + 1)}\n`, "utf8");
  }
  const versionPath = join(fixtureDirectory, "probe-version.txt");
  const version = existsSync(versionPath)
    ? readFileSync(versionPath, "utf8").trim()
    : "1.0.0-test";
  process.stdout.write(`fake-cli ${version}\n`);
  process.exit(0);
}
if (isHelpProbe) {
  const countPath = join(fixtureDirectory, "probe-count.txt");
  if (existsSync(countPath)) {
    const count = Number.parseInt(readFileSync(countPath, "utf8"), 10) || 0;
    writeFileSync(countPath, `${String(count + 1)}\n`, "utf8");
  }
  const omittedFlagPath = join(fixtureDirectory, "omit-flag.txt");
  const omittedFlag = existsSync(omittedFlagPath)
    ? readFileSync(omittedFlagPath, "utf8").trim()
    : undefined;
  if (probeMode === "help-barrier") {
    const readyPath = join(fixtureDirectory, "probe.ready");
    const releasePath = join(fixtureDirectory, "probe.release");
    writeFileSync(readyPath, "ready\n", "utf8");
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  process.stdout.write(
    [
      "fake provider help",
      "--sandbox",
      "--ephemeral",
      "--json",
      "--output-last-message",
      "--output-schema",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color",
      "-c",
      "-C",
      "--print",
      "--bare",
      "--safe-mode",
      "--output-format",
      "--tools",
      "--permission-mode",
      "--json-schema",
      "--model",
      "--no-session-persistence",
      "",
    ]
      .filter((line) => line !== omittedFlag)
      .join("\n"),
  );
  if (existsSync(join(fixtureDirectory, "delete-after-help"))) {
    unlinkSync(fixturePath);
  }
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const stdin = Buffer.concat(chunks).toString("utf8");
let request = {};
try {
  request = JSON.parse(stdin.split("\n", 1)[0] ?? "{}");
} catch {
  // Repair prompts follow the original JSON request on a later line.
}
const instructions =
  typeof request.systemInstructions === "string"
    ? request.systemInstructions
    : "";
const mode = /fixture-mode:([a-z-]+)/u.exec(instructions)?.[1] ?? "ok";
const pidFile = /^pid-file:(.+)$/mu.exec(instructions)?.[1];
const childPidFile = /^child-pid-file:(.+)$/mu.exec(instructions)?.[1];

if (pidFile !== undefined) {
  writeFileSync(pidFile, `${String(process.pid)}\n`, "utf8");
}

if (
  mode === "grandchild-ignore-sigterm" ||
  mode === "grandchild-oversized-stream"
) {
  const grandchild = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 60000)",
    ],
    { stdio: "ignore" },
  );
  grandchild.unref();
  if (childPidFile !== undefined && grandchild.pid !== undefined) {
    writeFileSync(childPidFile, `${String(grandchild.pid)}\n`, "utf8");
  }
}

if (mode === "invalid-once") {
  // Provider-specific invalid responses are emitted below.
}

if (mode === "fail") {
  process.stderr.write("boom");
  process.exit(2);
}

if (
  mode === "hang" ||
  mode === "ignore-sigterm" ||
  mode === "grandchild-ignore-sigterm"
) {
  if (mode === "ignore-sigterm") {
    process.on("SIGTERM", () => undefined);
  }
  if (mode === "grandchild-ignore-sigterm") {
    process.on("SIGTERM", () => undefined);
  }
  setInterval(() => undefined, 60_000);
} else if (
  mode === "oversized-stream" ||
  mode === "grandchild-oversized-stream"
) {
  const chunk = "x".repeat(8 * 1024);
  process.stdout.write(chunk);
  setInterval(() => process.stdout.write(chunk), 10);
} else if (args[0] === "exec") {
  emitCodexResponse();
} else {
  emitClaudeResponse();
}

function structuredContent(extra = {}) {
  const isLiveSoak = instructions.includes("cq-live-soak");
  if (isLiveSoak) return { ok: true, ping: "cq-live-soak" };
  if (
    mode === "schema-invalid-once" &&
    !stdin.includes("previous response failed validation")
  ) {
    return {};
  }
  const schema = requestedOutputSchema();
  if (
    schema?.additionalProperties === false &&
    Array.isArray(schema.required) &&
    schema.required.includes("candidates")
  ) {
    return { candidates: [] };
  }
  return {
    findings: [
      {
        id: "F1",
        severity: "P2",
        title: "Example finding",
        evidence: "synthetic path evidence in value.txt style",
      },
    ],
    candidates: [],
    summary: stdin.includes("previous response failed validation")
      ? "repaired"
      : "ok",
    ...extra,
  };
}

function argumentValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function requestedOutputSchema() {
  const schemaArgument = argumentValue("--json-schema");
  const schemaPath = argumentValue("--output-schema");
  try {
    if (schemaArgument !== undefined) return JSON.parse(schemaArgument);
    if (schemaPath !== undefined) {
      return JSON.parse(readFileSync(schemaPath, "utf8"));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function environmentSnapshot() {
  return {
    home: process.env.HOME ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    openAiApiKeyPresent: process.env.OPENAI_API_KEY !== undefined,
    anthropicApiKeyPresent: process.env.ANTHROPIC_API_KEY !== undefined,
    claudeOauthPresent: process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined,
    dangerousPresent: process.env.CQ_DANGEROUS_TEST_ENV !== undefined,
  };
}

function emitCodexResponse() {
  const outputPath = argumentValue("--output-last-message");
  const repairing =
    stdin.includes("REPAIR:") ||
    stdin.includes("previous response failed validation");
  if (mode === "invalid-once" && !repairing) {
    if (outputPath === undefined) {
      process.stdout.write("{not-json");
    } else {
      writeFileSync(outputPath, "{not-json", "utf8");
      emitCodexEvents();
    }
    return;
  }
  if (outputPath === undefined) {
    process.stdout.write(
      `${JSON.stringify({
        content: structuredContent({ repairPrompt: stdin }),
        usage: { input_tokens: 1, output_tokens: 2 },
        stop_reason: "end_turn",
        session_id: "fake-session",
      })}\n`,
    );
    return;
  }
  if (mode === "growing-output-file") {
    process.on("SIGTERM", () => undefined);
    const chunk = "f".repeat(4 * 1024);
    appendFileSync(outputPath, chunk, "utf8");
    setInterval(() => appendFileSync(outputPath, chunk, "utf8"), 5);
    return;
  }
  const outputMode = (statSync(outputPath).mode & 0o777).toString(8);
  if (mode === "oversized-output-file") {
    writeFileSync(outputPath, "x".repeat(128 * 1024), "utf8");
  } else {
    writeFileSync(
      outputPath,
      JSON.stringify(
        structuredContent({
          outputFileMode: outputMode,
          repairPrompt: stdin,
          environment: environmentSnapshot(),
          runtimeArgs: args,
        }),
      ),
      "utf8",
    );
  }
  chmodSync(outputPath, Number.parseInt(outputMode, 8));
  emitCodexEvents();
}

function emitCodexEvents() {
  const events = [
    { type: "thread.started", thread_id: "fake-thread" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "item-1",
        type: "agent_message",
        text: JSON.stringify(structuredContent()),
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 },
    },
  ];
  process.stdout.write(`${events.map(JSON.stringify).join("\n")}\n`);
}

function emitClaudeResponse() {
  const repairing =
    stdin.includes("REPAIR:") ||
    stdin.includes("previous response failed validation");
  if (mode === "invalid-once" && !repairing) {
    process.stdout.write("{not-json");
    return;
  }
  const schemaArgument = argumentValue("--json-schema");
  let schemaArgumentType = "missing";
  if (schemaArgument !== undefined) {
    try {
      JSON.parse(schemaArgument);
      schemaArgumentType = "json-string";
    } catch {
      schemaArgumentType = "path";
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: structuredContent({
        schemaArgumentType,
        repairPrompt: stdin,
        environment: environmentSnapshot(),
        runtimeArgs: args,
      }),
      usage:
        mode === "usage-invalid-once" && !repairing
          ? { input_tokens: "3", output_tokens: 4 }
          : { input_tokens: 3, output_tokens: 4 },
      session_id: "fake-claude-session",
    })}\n`,
  );
}
