const debugLogger = require("./debugLogger");

// Model families that are served by the bundled llama.cpp server. Used only to
// recover when a model family has been written into the provider field, so the
// ids must match modelRegistryData.json's localProviders exactly.
const LOCAL_MODEL_FAMILIES = ["qwen", "mistral", "llama", "openai-oss", "gemma", "liquidai"];

class MainProcessInference {
  constructor(proxyFetch, environmentManager) {
    this._fetch = proxyFetch;
    this._env = environmentManager;
  }

  async processText(text, { provider, model, systemPrompt, temperature = 0.3, maxTokens }) {
    const resolved = MainProcessInference.resolveProvider(provider, model);
    const handler = this._providers[resolved];
    if (!handler) {
      throw new Error(
        `Unsupported inference provider: "${provider}". ` +
          `Supported providers are: ${MainProcessInference.SUPPORTED_PROVIDERS.join(", ")}. ` +
          `Set this in Settings > AI Models > Note Formatting.`
      );
    }
    return handler.call(this, text, { model, systemPrompt, temperature, maxTokens });
  }

  /**
   * Settings has been observed persisting a model family ("gemma") into the
   * provider field. A locally-served model is still a local model, so resolve
   * it rather than failing the whole pipeline over a mislabelled field.
   */
  static resolveProvider(provider, model) {
    const value = String(provider || "").toLowerCase();
    if (MainProcessInference.SUPPORTED_PROVIDERS.includes(value)) return value;
    if (LOCAL_MODEL_FAMILIES.some((family) => value.startsWith(family))) return "local";
    // A GGUF-style model id with no recognisable provider is served locally.
    if (!value && /\.gguf$|-q\d|_k_m$/i.test(String(model || ""))) return "local";
    return value;
  }

  get _providers() {
    return {
      openai: this._callOpenAI,
      anthropic: this._callAnthropic,
      gemini: this._callGemini,
      local: this._callLocal,
    };
  }

  async _callLocal(text, { model, systemPrompt, temperature, maxTokens }) {
    const LocalReasoningService = require("../services/localReasoningBridge").default;
    return LocalReasoningService.processText(text, model, {
      systemPrompt,
      temperature,
      maxTokens,
    });
  }

  async _callOpenAI(text, { model, systemPrompt, temperature, maxTokens }) {
    const apiKey = this._env.getOpenAIKey();
    if (!apiKey) throw new Error("OpenAI API key not configured");

    const requestBody = {
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      store: false,
      max_output_tokens: maxTokens || Math.max(4096, Math.min(text.length * 2, 16384)),
    };
    if (temperature != null && !model.startsWith("o")) {
      requestBody.temperature = temperature;
    }

    const response = await this._fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      let msg = `OpenAI API error: ${response.status}`;
      try { msg = JSON.parse(errText).error?.message || msg; } catch {}
      throw new Error(msg);
    }

    const data = await response.json();
    return this._extractOpenAIText(data);
  }

  _extractOpenAIText(data) {
    if (Array.isArray(data?.output)) {
      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) return c.text.trim();
          }
        }
      }
    }
    if (typeof data?.output_text === "string") return data.output_text.trim();
    if (Array.isArray(data?.choices)) {
      const text = data.choices[0]?.message?.content;
      if (text) return text.trim();
    }
    throw new Error("Empty response from OpenAI");
  }

  async _callAnthropic(text, { model, systemPrompt, temperature, maxTokens }) {
    const apiKey = this._env.getAnthropicKey();
    if (!apiKey) throw new Error("Anthropic API key not configured");

    const requestBody = {
      model,
      messages: [{ role: "user", content: text }],
      system: systemPrompt,
      max_tokens: maxTokens || Math.max(100, Math.min(text.length * 2, 4096)),
      temperature: temperature ?? 0.3,
    };

    const response = await this._fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      let msg = `Anthropic API error: ${response.status}`;
      try { msg = JSON.parse(errText).error?.message || msg; } catch {}
      throw new Error(msg);
    }

    const data = await response.json();
    return data.content[0].text.trim();
  }

  async _callGemini(text, { model, systemPrompt, temperature, maxTokens }) {
    const apiKey = this._env.getGeminiKey();
    if (!apiKey) throw new Error("Gemini API key not configured");

    const requestBody = {
      contents: [{ parts: [{ text }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: temperature ?? 0.3,
        maxOutputTokens: maxTokens || 4096,
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      let msg = `Gemini API error: ${response.status}`;
      try { msg = JSON.parse(errText).error?.message || msg; } catch {}
      throw new Error(msg);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) throw new Error("Empty response from Gemini");
    return candidate.trim();
  }
}

MainProcessInference.SUPPORTED_PROVIDERS = ["openai", "anthropic", "gemini", "local"];

module.exports = { MainProcessInference };
