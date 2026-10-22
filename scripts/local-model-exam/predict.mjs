// Predicts speed and memory on each machine type's reference machine from what
// was measured here. Text-model times are split into reading the prompt and
// writing the answer, and each part is scaled by how fast the reference chip
// runs the same test model (llama 7B Q4_0) in published llama.cpp results.
// Every number this prints for another machine is a prediction.
//   node scripts/local-model-exam/predict.mjs --speech <dir> --text <dir>[,<dir>] --rates <dir> --out <file>
//     [--measured-chip <name> --measured-read <tokens/s> --measured-write <tokens/s>]
// The --measured-* flags give the measuring machine's own published llama 7B
// Q4_0 speeds (pp512 / tg128); the default is the M5 Pro the first exam ran on.
import fs from "node:fs";
import path from "node:path";
import { EXAM_DIR, listArg, parseArgs, readJson, readJsonl } from "./lib/cli.mjs";

const args = parseArgs();
const fmtS = (ms) =>
  ms == null || Number.isNaN(ms) ? "–" : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

// Published llama.cpp results, llama 7B Q4_0: prompt reading (pp512) and
// writing (tg128) in tokens per second.
// #4167: https://github.com/ggml-org/llama.cpp/discussions/4167 (Apple, Metal)
// #10879: https://github.com/ggml-org/llama.cpp/discussions/10879 (Vulkan and processor)
const MEASURED = args["measured-read"]
  ? {
      chip: args["measured-chip"] || "the measuring machine",
      read: Number(args["measured-read"]),
      write: Number(args["measured-write"]),
      source: "given on the command line",
    }
  : {
      chip: "Apple M5 Pro, 20-core graphics (307 GB/s)",
      read: 1620.64,
      write: 66.33,
      source: "#4167",
    };
const PROCESSOR = {
  read: 42.05,
  write: 7.35,
  source: "#10879: i7-1185G7 laptop, processor only, 4 threads",
};
const MACHINES = [
  {
    type: "1",
    name: "PC, no graphics card, 8 GB",
    ramGiB: 8,
    ...PROCESSOR,
    note: "optimistic: budget 8 GB laptops often have slower, single-channel memory",
  },
  {
    type: "2",
    name: "PC, built-in graphics, 16 GB",
    ramGiB: 16,
    ...PROCESSOR,
    note: "the app runs text on the processor unless the user installs the optional graphics pack; Iris Xe with it reads 106 and writes 5.9 (#10879), no faster",
  },
  {
    type: "3",
    name: "PC, NVIDIA 8 GB card (out of the box)",
    ramGiB: 16,
    ...PROCESSOR,
    note: "out of the box the app runs text on the processor",
  },
  {
    type: "3+",
    name: "PC, NVIDIA 8 GB card, graphics pack installed",
    ramGiB: 16,
    read: 2135.66,
    write: 59.53,
    source: "#10879: RTX 4060 laptop, Vulkan",
    note: "only after the user accepts the optional graphics download",
  },
  {
    type: "4a",
    name: "Mac under 16 GB (MacBook Neo, 8 GB)",
    ramGiB: 8,
    read: 117.96,
    write: 14.15 * (60 / 68),
    source: "no published row: M1 (#4167) with writing scaled by memory speed, 60/68 GB/s",
    note: "low confidence",
  },
  {
    type: "4b",
    name: "Mac 16–31 GB (M1, bottom of the band)",
    ramGiB: 16,
    read: 117.96,
    write: 14.15,
    source: "#4167: M1, 8-core graphics, 68 GB/s",
  },
  {
    type: "5",
    name: "Mac 32 GB+ (M4 32 GB, bottom of the band)",
    ramGiB: 32,
    read: 221.29,
    write: 24.11,
    source: "#4167: M4, 10-core graphics, 120 GB/s",
  },
];
const CLOUD_ANCHOR_MS = { 15: 1300, 60: 1300, 250: 4400, 600: 6700 };

const speechDir = args.speech;
const speech =
  speechDir && fs.existsSync(path.join(speechDir, "speech-summary.json"))
    ? readJson(path.join(speechDir, "speech-summary.json"))
    : null;
const speechRecords = speechDir ? readJsonl(path.join(speechDir, "records.jsonl")) : [];
const textModels = {};
for (const dir of listArg(args.text, []))
  Object.assign(textModels, readJson(path.join(dir, "text-summary.json")).models);
const rates = args.rates ? readJson(path.join(args.rates, "rates-summary.json")).models : {};

const lines = [];
const out = (s = "") => lines.push(s);
const predictions = { machines: MACHINES, text: {}, speech: {}, memory: {} };

// Scales a time measured here: the reading part by the reading ratio, the
// writing part by the writing ratio, anything else (requests, templates) as is.
const scale = (machine, { readMs = 0, writeMs = 0, otherMs = 0 }) =>
  readMs * (MEASURED.read / machine.read) +
  writeMs * (MEASURED.write / machine.write) +
  Math.max(0, otherMs);

out(`## How fast each text model reads and writes on the measuring machine`);
out();
out(
  `Measured with llama-server's own timings, as the app sends a cleanup. "Re-read" is what the second of two cleanups reads again; the rest of the fixed instructions is reused from the previous request.`
);
out();
out(
  `| Model | Reads (tokens/s) | Writes (tokens/s) | Cleanup prompt, 60 words (tokens) | Re-read on the next cleanup | Model load | Agent prompt (tokens) | Agent: re-read on the next request |`
);
out(`|---|---|---|---|---|---|---|---|`);
for (const [id, r] of Object.entries(rates)) {
  const c = r.cleanup?.[60] || {};
  const a = r.agent || {};
  out(
    `| ${id} | ${c.readPerSecond ?? "–"} | ${c.writePerSecond ?? "–"} | ${c.promptTokens ?? "–"} | ${c.readAgainTokens ?? "–"} | ${fmtS(r.loadMs)} | ${a.promptTokens ?? "–"}${a.gotTools ? "" : " (no tools)"} | ${a.secondTurnReadAgainTokens ?? "–"} of ${a.promptTokens ?? "–"} |`
  );
}
out();

out(`## Predicted cleanup time on each machine type`);
out();
out(
  `Cleanup alone, before the speech wait is added. Warm = the model is loaded and the instructions are reused; first = the first cleanup after the model loads (load time measured here: slower disks add more). Bar for the whole dictation: 1.3 s under 100 words, 4.4 s at 250.`
);
out();
const textIds = Object.keys(rates).filter((id) => textModels[id]);
out(
  `| Machine type | ${textIds.map((id) => `${id}: 60 words warm / first / 250 warm`).join(" | ")} |`
);
out(`|---|${textIds.map(() => "---").join("|")}|`);
for (const machine of [
  { type: "here", name: "measured here", read: MEASURED.read, write: MEASURED.write },
  ...MACHINES,
]) {
  const cells = textIds.map((id) => {
    const r = rates[id];
    const c60 = r.cleanup[60];
    const c250 = r.cleanup[250];
    const warm = (c) =>
      scale(machine, {
        readMs: c.readAgainMs,
        writeMs: c.reusedWriteMs,
        otherMs: c.reusedRequestMs - c.readAgainMs - c.reusedWriteMs,
      });
    const first = (c) =>
      r.loadMs +
      scale(machine, {
        readMs: c.readMs,
        writeMs: c.writeMs,
        otherMs: c.fullRequestMs - c.readMs - c.writeMs,
      });
    const p = { warm60: warm(c60), first60: first(c60), warm250: warm(c250) };
    ((predictions.text[id] ||= {}).cleanup ||= {})[machine.type] = p;
    return `${fmtS(p.warm60)} / ${fmtS(p.first60)} / ${fmtS(p.warm250)}`;
  });
  out(
    `| ${machine.type === "here" ? "Measuring machine (measured parts, summed)" : `${machine.type}. ${machine.name}`} | ${cells.join(" | ")} |`
  );
}
out();

out(`## Predicted agent speed (models that get tools)`);
out();
out(
  `First words: the earliest of the first visible text or the first tool call, median of the agent tasks measured here. The reading part is what a new request reads again; the rest (mostly thinking) scales with writing speed. Bars: 3 s to first words, 15 s for a two-step request.`
);
out();
const toolIds = textIds.filter(
  (id) => rates[id].agent?.gotTools && textModels[id].agent?.firstWordsMedianMs
);
out(`| Machine type | ${toolIds.map((id) => `${id}: first words / two-step`).join(" | ")} |`);
out(`|---|${toolIds.map(() => "---").join("|")}|`);
for (const machine of [
  { type: "here", name: "measured here", read: MEASURED.read, write: MEASURED.write },
  ...MACHINES,
]) {
  const cells = toolIds.map((id) => {
    const readMs = rates[id].agent.secondTurnReadAgainMs ?? 0;
    const fw = textModels[id].agent.firstWordsMedianMs;
    const two = textModels[id].agent.twoStepMedianMs;
    const p = {
      firstWords: scale(machine, { readMs, writeMs: fw - readMs }),
      twoStep: two == null ? null : scale(machine, { readMs, writeMs: two - readMs }),
    };
    ((predictions.text[id] ||= {}).agent ||= {})[machine.type] = p;
    return `${fmtS(p.firstWords)} / ${fmtS(p.twoStep)}`;
  });
  out(
    `| ${machine.type === "here" ? "Measuring machine (measured)" : `${machine.type}. ${machine.name}`} | ${cells.join(" | ")} |`
  );
}
out();

if (speech) {
  out(`## Speech: how much speed every other machine would need`);
  out();
  out(
    `Offline models decode the whole recording after you stop, so their wait grows with length. The table gives the slower of the warm and first-after-loading waits here, at a normal 150 words a minute, and how much slower than the measuring machine a machine can be before one length misses the cloud's bar. A model that fails here fails on every slower machine. Streaming models finish about a tenth of a second after you stop at any length; for them the question is whether a slower machine keeps up live, which the share of real time used here answers.`
  );
  out();
  out(
    `| Model | Kind | 15 words | 60 words | 250 words | 600 words | A machine can be up to … slower and still pass every length | Share of real time used here |`
  );
  out(`|---|---|---|---|---|---|---|---|`);
  for (const [id, m] of Object.entries(speech.models)) {
    const slack = [];
    const cells = [15, 60, 250, 600].map((w) => {
      const v = m.speed?.[w];
      if (!v) return "–";
      const wait = Math.max(
        v.estimatedAt150wpm?.warmMs ?? v.warmMedianMs,
        v.estimatedAt150wpm?.coldMs ?? v.coldMs ?? 0
      );
      const need = wait / CLOUD_ANCHOR_MS[w];
      slack.push(1 / need);
      return `${fmtS(wait)} (${need <= 1 ? "passes" : `needs ${need.toFixed(1)}× faster`})`;
    });
    const headroom = slack.length ? Math.min(...slack) : null;
    // Share of real time: decode time over audio length across the accuracy clips.
    const acc = speechRecords.filter(
      (r) => r.task === "accuracy" && r.model === id && r.ok && r.ms != null
    );
    const secondsOfClip = (r) => r.audioSeconds ?? clipSeconds(r.clip);
    const totalMs = acc.reduce((a, r) => a + r.ms, 0);
    const totalAudio = acc.reduce((a, r) => a + (secondsOfClip(r) || 0), 0);
    const share = totalAudio ? totalMs / (totalAudio * 1000) : null;
    predictions.speech[id] = { kind: m.kind, shareOfRealTime: share, headroom };
    const kind =
      m.kind === "sherpa-online"
        ? "streaming (processor)"
        : m.kind === "whisper"
          ? "offline (graphics chip on a Mac)"
          : "offline (processor)";
    const room =
      m.kind === "sherpa-online"
        ? share
          ? `${(1 / share).toFixed(0)}× (keeps up live)`
          : "–"
        : headroom >= 1
          ? `${headroom.toFixed(1)}×`
          : "fails here";
    out(
      `| ${id} | ${kind} | ${cells.join(" | ")} | ${room} | ${share == null ? "–" : `${(share * 100).toFixed(1)}%`} |`
    );
  }
  out();

  out(`## Memory: both models together against half the reference machine's RAM`);
  out();
  out(
    `Peak memory measured here for each engine on its own (text models with the agent's full working memory), added together. The same model files need about the same memory on other machines.`
  );
  out();
  const speechIds = Object.keys(speech.models).filter((id) => speech.models[id].peakMiB);
  const pairIds = textIds.filter((id) => textModels[id].peakMiB);
  for (const machine of MACHINES.filter((m) => m.type !== "3+")) {
    const limit = (machine.ramGiB / 2) * 1024;
    const fits = [];
    for (const s of speechIds)
      for (const t of pairIds)
        if (speech.models[s].peakMiB + textModels[t].peakMiB <= limit) fits.push(`${s} + ${t}`);
    const speechAlone = speechIds.filter((s) => speech.models[s].peakMiB <= limit);
    predictions.memory[machine.type] = {
      limitMiB: limit,
      pairsThatFit: fits,
      speechThatFitsAlone: speechAlone,
    };
    out(
      `- **${machine.type}. ${machine.name}** (limit ${(limit / 1024).toFixed(0)} GB): ${fits.length ? `${fits.length} pairs fit` : "no speech + text pair fits"}; speech models that fit on their own: ${speechAlone.length} of ${speechIds.length}.`
    );
  }
  out();
}

out(
  `Reference speeds (llama 7B Q4_0, reading / writing tokens per second): measuring machine (${MEASURED.chip}) ${MEASURED.read} / ${MEASURED.write} (${MEASURED.source}); ${MACHINES.map((m) => `type ${m.type} ${m.read.toFixed(0)} / ${m.write.toFixed(1)} (${m.source}${m.note ? `; ${m.note}` : ""})`).join("; ")}.`
);

function clipSeconds(clipId) {
  const match = /^(fleurs|tts)-([a-z]+)-(\d+)$/.exec(clipId || "");
  if (!match) return null;
  const file = path.join(EXAM_DIR, ".cache", match[1], match[2], `${match[3]}.pcm`);
  return fs.existsSync(file) ? fs.statSync(file).size / 32000 : null;
}

fs.writeFileSync(args.out, lines.join("\n") + "\n");
fs.writeFileSync(args.out.replace(/\.md$/, ".json"), JSON.stringify(predictions, null, 2));
console.log("wrote", args.out);
