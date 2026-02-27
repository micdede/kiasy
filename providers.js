const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");

// --- Anthropic Provider ---

class AnthropicProvider {
  constructor({ apiKey, model, maxTokens }) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.maxTokens = maxTokens;
    this.name = `anthropic/${model}`;
  }

  async chat(system, messages, tools) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: tools.length > 0 ? tools : undefined,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length > 0) {
      return {
        type: "tool_use",
        toolCalls: toolUses.map((t) => ({
          id: t.id,
          name: t.name,
          input: t.input,
        })),
        _raw: response.content,
      };
    }

    return {
      type: "text",
      text: response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      _raw: response.content,
    };
  }

  pushAssistant(history, result) {
    history.push({ role: "assistant", content: result._raw });
  }

  pushToolResults(history, results) {
    history.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.callId,
        content: String(r.content),
      })),
    });
  }
}

// --- OpenAI-kompatible Provider (Ollama, Groq, OpenAI, etc.) ---

class OpenAICompatibleProvider {
  constructor({ baseURL, apiKey, model, maxTokens, name }) {
    this.client = new OpenAI({
      baseURL,
      apiKey: apiKey || "ollama",
    });
    this.model = model;
    this.maxTokens = maxTokens;
    this.name = name || `openai-compat/${model}`;
  }

  async chat(system, messages, tools) {
    const oaiMessages = this._toOpenAI(system, messages);
    const oaiTools = this._convertTools(tools);

    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: oaiMessages,
    };
    if (oaiTools.length > 0) {
      params.tools = oaiTools;
    }

    const response = await this.client.chat.completions.create(params);
    const msg = response.choices[0].message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCalls = msg.tool_calls.map((tc, i) => ({
        id: tc.id || `call_${Date.now()}_${i}`,
        name: tc.function.name,
        input:
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
      }));

      return {
        type: "tool_use",
        toolCalls,
        _raw: msg,
      };
    }

    // Fallback: XML-Tool-Calls aus Text parsen (z.B. DeepSeek)
    if (msg.content && msg.content.includes("<function_calls>")) {
      const xmlCalls = this._parseXmlToolCalls(msg.content);
      if (xmlCalls.length > 0) {
        // Text vor den XML-Tags als content behalten
        const textBefore = msg.content.split("<function_calls>")[0].trim();
        msg.content = textBefore || null;
        return {
          type: "tool_use",
          toolCalls: xmlCalls,
          _raw: msg,
        };
      }
    }

    return {
      type: "text",
      text: msg.content || "",
      _raw: msg,
    };
  }

  // History wird intern in Anthropic-Format gespeichert.
  // pushAssistant konvertiert OpenAI-Response → Anthropic-Format.
  pushAssistant(history, result) {
    const content = [];
    if (result._raw.content) {
      content.push({ type: "text", text: result._raw.content });
    }
    if (result.type === "tool_use") {
      for (const tc of result.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
    }
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }
    history.push({ role: "assistant", content });
  }

  pushToolResults(history, results) {
    history.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.callId,
        content: String(r.content),
      })),
    });
  }

  // Anthropic-History → OpenAI-Messages
  _toOpenAI(system, anthropicMessages) {
    const messages = [{ role: "system", content: system }];

    for (const msg of anthropicMessages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({ role: "user", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_result") {
              messages.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: String(block.content),
              });
            }
          }
        }
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          messages.push({ role: "assistant", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const texts = msg.content.filter((b) => b.type === "text");
          const toolUses = msg.content.filter((b) => b.type === "tool_use");

          if (toolUses.length > 0) {
            messages.push({
              role: "assistant",
              content: texts.map((t) => t.text).join("\n") || null,
              tool_calls: toolUses.map((tu) => ({
                id: tu.id,
                type: "function",
                function: {
                  name: tu.name,
                  arguments: JSON.stringify(tu.input),
                },
              })),
            });
          } else {
            messages.push({
              role: "assistant",
              content: texts.map((t) => t.text).join("\n") || "",
            });
          }
        }
      }
    }

    return messages;
  }

  _parseXmlToolCalls(text) {
    const calls = [];
    const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let match;
    while ((match = invokeRegex.exec(text)) !== null) {
      const name = match[1];
      const paramsBlock = match[2];
      const input = {};
      const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([^<]*)<\/parameter>/g;
      let pm;
      while ((pm = paramRegex.exec(paramsBlock)) !== null) {
        const val = pm[2];
        // Zahlen und Booleans konvertieren
        if (val === "true") input[pm[1]] = true;
        else if (val === "false") input[pm[1]] = false;
        else if (/^\d+(\.\d+)?$/.test(val)) input[pm[1]] = Number(val);
        else input[pm[1]] = val;
      }
      calls.push({ id: `call_${Date.now()}_${calls.length}`, name, input });
    }
    return calls;
  }

  _convertTools(tools) {
    if (!tools || tools.length === 0) return [];
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }
}

// --- Provider Factory ---

function createProvider(config) {
  const provider = (config.provider || "anthropic").toLowerCase();

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(config);

    case "ollama":
      return new OpenAICompatibleProvider({
        ...config,
        name: `ollama/${config.model}`,
      });

    case "groq":
      return new OpenAICompatibleProvider({
        ...config,
        baseURL: config.baseURL || "https://api.groq.com/openai/v1",
        name: `groq/${config.model}`,
      });

    case "openai":
      return new OpenAICompatibleProvider({
        ...config,
        baseURL: config.baseURL || "https://api.openai.com/v1",
        name: `openai/${config.model}`,
      });

    default:
      throw new Error(`Unbekannter Provider: ${provider}`);
  }
}

module.exports = { createProvider };
