// Synthetic, loopback-only model qualification. Never captures or pastes text.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildLocalSelectionEditSystemPrompt,
  buildLocalSelectionEditUserPrompt,
  extractLocalSelectionEditReplacement,
  SELECTION_EDIT_RESPONSE_FORMAT,
} from "../../src/helpers/selectionEditing.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const endpoint = new URL(option("--endpoint", "http://127.0.0.1:18229"));
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
  throw new Error("Use an explicit loopback HTTP server; this runner never sends text remotely.");
}
const fixtures = JSON.parse(
  await fs.readFile(option("--fixtures", new URL("./regression.json", import.meta.url)), "utf8")
);
const cases = fixtures.cases;
const seeds = option("--seeds", "73,89").split(",").map(Number);
if (!args.includes("--run")) {
  console.log(
    JSON.stringify({ cases: cases.length, seeds, requests: cases.length * seeds.length })
  );
  process.exit(0);
}
const out = option("--out");
if (!out) throw new Error("--out must name a new output file");
const handle = await fs.open(out, "wx");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const helperSha256 = sha256(
  await fs.readFile(new URL("../../src/helpers/selectionEditing.js", import.meta.url))
);
const props = await fetch(new URL("/props", endpoint)).then((r) => r.json());
const identity = {
  model: path.basename(props.model_path),
  build: props.build_info,
  context: props.default_generation_settings.n_ctx,
};
let accepted = 0;
let exact = 0;
let total = 0;
try {
  for (const fixture of cases) {
    for (const seed of seeds) {
      const system = buildLocalSelectionEditSystemPrompt();
      const body = {
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: buildLocalSelectionEditUserPrompt(fixture.instruction, fixture.text),
          },
        ],
        temperature: 0.2,
        max_tokens: 8192,
        seed,
        stream: false,
        response_format: SELECTION_EDIT_RESPONSE_FORMAT,
        chat_template_kwargs: { enable_thinking: false },
      };
      const start = Date.now();
      const response = await fetch(new URL("/v1/chat/completions", endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}; stopping without scoring a transport failure`);
      const data = await response.json();
      const choice = data.choices?.[0];
      let replacement;
      let error;
      try {
        if (choice?.finish_reason !== "stop") throw new Error(`finish:${choice?.finish_reason}`);
        replacement = extractLocalSelectionEditReplacement(choice?.message?.content);
      } catch (cause) {
        error = cause.code || cause.message;
      }
      const protocol = error === undefined;
      const correct = protocol && replacement === fixture.expected;
      accepted += Number(protocol);
      exact += Number(correct);
      total++;
      await handle.write(
        JSON.stringify({
          id: fixture.id,
          seed,
          ...identity,
          helperSha256,
          promptSha256: sha256(system),
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          finishReason: choice?.finish_reason,
          protocol,
          exact: correct,
          error,
          ms: Date.now() - start,
          output: choice?.message?.content,
          replacement,
          expected: fixture.expected,
          instruction: fixture.instruction,
          selectedText: fixture.text,
        }) + "\n"
      );
      console.log(JSON.stringify({ id: fixture.id, seed, protocol, exact: correct, total }));
    }
  }
} finally {
  await handle.close();
}
console.log(JSON.stringify({ total, accepted, exact, helperSha256, ...identity }));
