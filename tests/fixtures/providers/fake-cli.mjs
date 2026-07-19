#!/usr/bin/env node
import { readFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const stdin = Buffer.concat(chunks).toString("utf8");
const mode = process.env.CQ_FAKE_PROVIDER_MODE ?? "ok";

if (mode === "invalid-once") {
  if (!stdin.includes("REPAIR:")) {
    process.stdout.write("{not-json");
    process.exit(0);
  }
}

if (mode === "fail") {
  process.stderr.write("boom");
  process.exit(2);
}

if (mode === "hang") {
  setInterval(() => undefined, 60_000);
} else {
  const payload = {
    content: {
      findings: [
        {
          id: "F1",
          severity: "P2",
          title: "Example finding",
          evidence: "synthetic",
        },
      ],
      summary: "ok",
    },
    usage: { input_tokens: 1, output_tokens: 2 },
    stop_reason: "end_turn",
    session_id: "fake-session",
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
