import { DuckAI } from "./duckai";
import { ToolService } from "./tool-service";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionStreamResponse, ModelsResponse, Model, DuckAIRequest, ToolCall } from "./types";

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}

export class OpenAIService {
  private duckAI: DuckAI;
  private toolService: ToolService;
  private availableFunctions: Record<string, Function>;

  constructor() {
    this.duckAI = new DuckAI();
    this.toolService = new ToolService();
    this.availableFunctions = this.initializeBuiltInFunctions();
  }

  private initializeBuiltInFunctions(): Record<string, Function> {
    return {
      get_current_time: () => new Date().toISOString(),
      calculate: (args: { expression: string }) => {
        try {
          if (!/^[\d\s+\-*/().]+$/.test(args.expression)) return { error: "Invalid characters" };
          return { result: Function(`"use strict"; return (${args.expression})`)() };
        } catch { return { error: "Invalid expression" }; }
      },
      get_weather: (args: { location: string }) => ({
        location: args.location, temperature: Math.floor(Math.random() * 30) + 10,
        condition: ["sunny", "cloudy", "rainy"][Math.floor(Math.random() * 3)],
      }),
    };
  }

  private generateId(): string { return `chatcmpl-${Math.random().toString(36).substring(2, 15)}`; }
  private getCurrentTimestamp(): number { return Math.floor(Date.now() / 1000); }
  private estimateTokens(text: string): number { return Math.ceil((text || "").length / 4); }

  private transformToDuckAIRequest(request: ChatCompletionRequest): DuckAIRequest {
    const model = request.model || "gpt-4o-mini";
    let systemPrompt = "";
    const sanitizedMessages: any[] = [];
    for (const msg of request.messages) {
      if (msg.role === "system") systemPrompt += (msg.content || "") + "\n\n";
      else sanitizedMessages.push({ ...msg });
    }
    if (systemPrompt && sanitizedMessages.length > 0) {
      const firstUserMsg = sanitizedMessages.find((m) => m.role === "user");
      if (firstUserMsg) {
        // 🛡️ AUDIT FIX: Prevent literal "null" string injection if content is null
        firstUserMsg.content = `[SYSTEM INSTRUCTIONS]\n${systemPrompt.trim()}\n\n[USER QUERY]\n${firstUserMsg.content || ""}`;
      } else {
        sanitizedMessages.unshift({ role: "user", content: systemPrompt.trim() });
      }
    }
    return { model, messages: sanitizedMessages };
  }

  private buildCompletionResponse(id: string, created: number, model: string, content: string | null, toolCalls: ToolCall[] | null, finishReason: "stop" | "tool_calls", messages: any[], responseText: string): ChatCompletionResponse {
    const promptTokens = this.estimateTokens(messages.map((m) => m.content || "").join(" "));
    const completionTokens = this.estimateTokens(responseText);
    return {
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls && { tool_calls: toolCalls }) }, finish_reason: finishReason }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    };
  }

  async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (this.toolService.shouldUseFunctionCalling(request.tools, request.tool_choice)) return this.createChatCompletionWithTools(request);
    const duckAIRequest = this.transformToDuckAIRequest(request);
    const response = await this.duckAI.chat(duckAIRequest);
    return this.buildCompletionResponse(this.generateId(), this.getCurrentTimestamp(), request.model, response, null, "stop", request.messages, response);
  }

  private async createChatCompletionWithTools(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const id = this.generateId(); const created = this.getCurrentTimestamp();
    if (request.tools) {
      const validation = this.toolService.validateTools(request.tools);
      if (!validation.valid) throw new ValidationError(`Invalid tools: ${validation.errors.join(", ")}`);
    }
    const modifiedMessages = [...request.messages];
    if (request.tools && request.tools.length > 0) {
      const toolPrompt = this.toolService.generateToolSystemPrompt(request.tools, request.tool_choice);
      modifiedMessages.unshift({ role: "user", content: `[SYSTEM INSTRUCTIONS] ${toolPrompt}\n\nPlease follow these instructions.` });
    }
    const duckAIRequest = this.transformToDuckAIRequest({ ...request, messages: modifiedMessages });
    const response = await this.duckAI.chat(duckAIRequest);

    if (this.toolService.detectFunctionCalls(response)) {
      const toolCalls = this.toolService.extractFunctionCalls(response);
      if (toolCalls.length > 0) return this.buildCompletionResponse(id, created, request.model, null, toolCalls, "tool_calls", modifiedMessages, response);
    }

    const isForced = request.tool_choice === "required" || (typeof request.tool_choice === "object" && request.tool_choice.type === "function");
    if (isForced && request.tools && request.tools.length > 0) {
      const forcedToolCall = this.generateForcedToolCall(request);
      return this.buildCompletionResponse(id, created, request.model, null, [forcedToolCall], "tool_calls", modifiedMessages, JSON.stringify(forcedToolCall));
    }

    return this.buildCompletionResponse(id, created, request.model, response, null, "stop", modifiedMessages, response);
  }

  private generateForcedToolCall(request: ChatCompletionRequest): ToolCall {
    const userContent = request.messages[request.messages.length - 1]?.content || "";
    let functionToCall = request.tools![0].function.name;
    if (typeof request.tool_choice === "object" && request.tool_choice.type === "function") functionToCall = request.tool_choice.function.name;
    let args = "{}";
    if (functionToCall === "calculate") {
      const match = userContent.match(/(\d+\s*[+\-*/]\s*\d+)/);
      if (match) args = JSON.stringify({ expression: match[1] });
    } else if (functionToCall === "get_weather") {
      const match = userContent.match(/(?:in|for|at)\s+([A-Za-z\s,]+)/i);
      if (match) args = JSON.stringify({ location: match[1].trim() });
    }
    return { id: `call_${Date.now()}`, type: "function", function: { name: functionToCall, arguments: args } };
  }

  async createChatCompletionStream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>> {
    if (this.toolService.shouldUseFunctionCalling(request.tools, request.tool_choice)) return this.createChatCompletionStreamWithTools(request);
    const duckAIRequest = this.transformToDuckAIRequest(request);
    const duckStream = await this.duckAI.chatStream(duckAIRequest);
    const id = this.generateId(); const created = this.getCurrentTimestamp(); const model = request.model;
    const reader = duckStream.getReader(); let isFirst = true;

    return new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
            controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
            controller.close(); return;
          }
          const delta = isFirst ? { role: "assistant", content: value } : { content: value };
          isFirst = false;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`));
        } catch (error) { controller.error(error); }
      },
      cancel() { reader.cancel(); }
    });
  }

  private async createChatCompletionStreamWithTools(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>> {
    const completion = await this.createChatCompletionWithTools(request);
    const id = completion.id; const created = completion.created; const model = completion.model; const choice = completion.choices[0];
    return new ReadableStream({
      start: (controller) => {
        const encoder = new TextEncoder();
        const enqueue = (chunk: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (choice.message.tool_calls) {
          enqueue({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: choice.message.tool_calls }, finish_reason: null }] });
          enqueue({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          const content = choice.message.content || "";
          enqueue({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          for (let i = 0; i < content.length; i += 10) enqueue({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: content.slice(i, i + 10) }, finish_reason: null }] });
          enqueue({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        }
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      }
    });
  }

  getModels(): ModelsResponse {
    const models = this.duckAI.getAvailableModels(); const created = this.getCurrentTimestamp();
    return { object: "list", data: models.map((modelId) => ({ id: modelId, object: "model", created, owned_by: "duckai" })) as Model[] };
  }

  validateRequest(request: any): ChatCompletionRequest {
    if (!request.messages || !Array.isArray(request.messages)) throw new ValidationError("messages field is required and must be an array");
    if (request.messages.length === 0) throw new ValidationError("messages array cannot be empty");
    for (const message of request.messages) {
      if (!message.role || !["system", "user", "assistant", "tool"].includes(message.role)) throw new ValidationError("Invalid message role");
      if (message.role === "tool") {
        if (!message.tool_call_id) throw new ValidationError("Tool messages must have a tool_call_id");
        if (typeof message.content !== "string") throw new ValidationError("Tool messages must have string content");
      } else {
        if (message.content === undefined || (message.content !== null && typeof message.content !== "string")) throw new ValidationError("Message content must be string or null");
      }
    }
    if (request.tools) {
      const validation = this.toolService.validateTools(request.tools);
      if (!validation.valid) throw new ValidationError(`Invalid tools: ${validation.errors.join(", ")}`);
    }
    return { model: request.model || "gpt-4o-mini", messages: request.messages, stream: request.stream || false, tools: request.tools, tool_choice: request.tool_choice };
  }

  async shutdown(): Promise<void> { await this.duckAI.shutdown(); }
}
