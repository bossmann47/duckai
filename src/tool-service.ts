import { ToolDefinition, ToolCall, ToolChoice, ChatCompletionMessage } from "./types";

export class ToolService {
  generateToolSystemPrompt(tools: ToolDefinition[], toolChoice: ToolChoice = "auto"): string {
    const toolDescriptions = tools.map((tool) => {
      const func = tool.function;
      let description = `${func.name}`;
      if (func.description) description += `: ${func.description}`;
      if (func.parameters) {
        const params = func.parameters.properties || {};
        const required = func.parameters.required || [];
        const paramDescriptions = Object.entries(params).map(([name, schema]: [string, any]) => {
          const isRequired = required.includes(name);
          const type = schema.type || "any";
          const desc = schema.description || "";
          return `  - ${name} (${type}${isRequired ? ", required" : ", optional"}): ${desc}`;
        }).join("\n");
        if (paramDescriptions) description += `\nParameters:\n${paramDescriptions}`;
      }
      return description;
    }).join("\n\n");

    let prompt = `You are an AI assistant with access to the following functions. When you need to call a function, respond with a JSON object in this exact format:\n\n{\n  "tool_calls": [\n    {\n      "id": "call_<unique_id>",\n      "type": "function",\n      "function": {\n        "name": "<function_name>",\n        "arguments": "<json_string_of_arguments>"\n      }\n    }\n  ]\n}\n\nAvailable functions:\n${toolDescriptions}\n\nImportant rules:\n1. Only call functions when necessary\n2. Use exact function names\n3. Provide arguments as a JSON string\n4. Generate unique IDs\n5. If no functions needed, respond normally`;

    if (toolChoice === "required") prompt += "\n6. You MUST call at least one function";
    else if (toolChoice === "none") prompt += "\n6. Do NOT call any functions";
    else if (typeof toolChoice === "object" && toolChoice.type === "function") prompt += `\n6. You MUST call "${toolChoice.function.name}"`;

    return prompt;
  }

  detectFunctionCalls(content: string): boolean {
    try {
      const parsed = JSON.parse(content.trim());
      return parsed.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0;
    } catch {
      return /["']?tool_calls["']?\s*:\s*\[/.test(content);
    }
  }

  extractFunctionCalls(content: string): ToolCall[] {
    try {
      const parsed = JSON.parse(content.trim());
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        return parsed.tool_calls.map((call: any, index: number) => ({
          id: call.id || `call_${Date.now()}_${index}`,
          type: "function",
          function: {
            name: call.function.name,
            arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments),
          },
        }));
      }
    } catch { /* Fallback below */ }
    return [];
  }

  async executeFunctionCall(toolCall: ToolCall, availableFunctions: Record<string, Function>): Promise<string> {
    const functionName = toolCall.function.name;
    const functionToCall = availableFunctions[functionName];
    if (!functionToCall) return JSON.stringify({ error: `Function '${functionName}' not found` });

    try {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await functionToCall(args);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: `Error executing function '${functionName}'` });
    }
  }

  validateTools(tools: ToolDefinition[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!Array.isArray(tools)) return { valid: false, errors: ["Tools must be an array"] };
    tools.forEach((tool, index) => {
      if (!tool.type || tool.type !== "function") errors.push(`Tool ${index}: type must be "function"`);
      if (!tool.function) errors.push(`Tool ${index}: function definition required`);
      else if (!tool.function.name) errors.push(`Tool ${index}: function name required`);
    });
    return { valid: errors.length === 0, errors };
  }

  shouldUseFunctionCalling(tools?: ToolDefinition[], toolChoice?: ToolChoice): boolean {
    if (!tools || tools.length === 0 || toolChoice === "none") return false;
    return true;
  }
}
