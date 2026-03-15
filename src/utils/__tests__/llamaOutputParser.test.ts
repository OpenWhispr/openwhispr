import { describe, it, expect } from "vitest";
import { parseLlamaCppOutput } from "../llamaOutputParser";

describe("parseLlamaCppOutput", () => {
  it("returns empty string for null/undefined/empty input", () => {
    expect(parseLlamaCppOutput(null)).toBe("");
    expect(parseLlamaCppOutput(undefined)).toBe("");
    expect(parseLlamaCppOutput("")).toBe("");
  });

  it("returns plain text as-is", () => {
    expect(parseLlamaCppOutput("Hello, world!")).toBe("Hello, world!");
  });

  it("filters out llama_ diagnostic lines", () => {
    const output = "llama_model_load: loaded successfully\nHello there";
    expect(parseLlamaCppOutput(output)).toBe("Hello there");
  });

  it("filters out ggml_ diagnostic lines", () => {
    const output = "ggml_init: allocating memory\nActual output";
    expect(parseLlamaCppOutput(output)).toBe("Actual output");
  });

  it("filters out timing statistics", () => {
    const output = [
      "The answer is 42.",
      "  load time =   150.32 ms",
      "  sample time =   25.10 ms",
      "  prompt eval time =   100.00 ms",
      "  eval time =   500.00 ms",
      "  total time =   800.00 ms",
    ].join("\n");
    expect(parseLlamaCppOutput(output)).toBe("The answer is 42.");
  });

  it("filters out system_info, main, sampling, generate lines", () => {
    const output = [
      "main: starting inference",
      "sampling: temperature=0.7",
      "generate: n_tokens=100",
      "system_info: threads=8",
      "This is the actual response.",
    ].join("\n");
    expect(parseLlamaCppOutput(output)).toBe("This is the actual response.");
  });

  it("filters out build and log lines", () => {
    const output = "Log start\nbuild: 1234 abc\nn_threads = 8\nUsing CUDA backend\nResult";
    expect(parseLlamaCppOutput(output)).toBe("Result");
  });

  it("filters out token count lines", () => {
    const output = "  128 tokens processed\nHello";
    expect(parseLlamaCppOutput(output)).toBe("Hello");
  });

  it("removes <|im_end|> end token", () => {
    expect(parseLlamaCppOutput("Hello world<|im_end|>")).toBe("Hello world");
  });

  it("removes <|end|> end token", () => {
    expect(parseLlamaCppOutput("Hello world<|end|>")).toBe("Hello world");
  });

  it("removes </s> end token", () => {
    expect(parseLlamaCppOutput("Hello world</s>")).toBe("Hello world");
  });

  it("removes [end of text] end token", () => {
    expect(parseLlamaCppOutput("Hello world [end of text]")).toBe("Hello world");
  });

  it("skips leading empty lines but preserves mid-content empty lines", () => {
    const output = "\n\n\nFirst line\n\nSecond line";
    expect(parseLlamaCppOutput(output)).toBe("First line\n\nSecond line");
  });

  it("handles mixed diagnostic and content lines", () => {
    const output = [
      "llama_model_load: loaded",
      "ggml_init: ok",
      "",
      "Here is my response.",
      "It has multiple lines.",
      "  eval time = 200.00 ms",
      "  total time = 500.00 ms",
    ].join("\n");
    expect(parseLlamaCppOutput(output)).toBe(
      "Here is my response.\nIt has multiple lines."
    );
  });
});
