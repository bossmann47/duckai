import { OpenAIService, ValidationError } from "./openai-service";
import { randomUUID } from "node:crypto";

const openAIService = new OpenAIService();

const server = Bun.serve({
  port: process.env.PORT || 3000,
  hostname: process.env.HOST || "0.0.0.0",

  async fetch(req) {
    const startTime = Date.now();
    const url = new URL(req.url);
    const requestId = randomUUID().split("-")[0];

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "X-Request-ID": requestId,
    };

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        return new Response(JSON.stringify(openAIService.getModels()), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body: any;
        try { body = await req.json(); } catch (e) { throw new ValidationError("Invalid JSON payload"); }

        const validatedRequest = openAIService.validateRequest(body);

        if (validatedRequest.stream) {
          const stream = await openAIService.createChatCompletionStream(validatedRequest);
          console.log(`[${requestId}] 🌊 Streaming response for model: ${validatedRequest.model}`);
          return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders } });
        }

        const completion = await openAIService.createChatCompletion(validatedRequest);
        console.log(`[${requestId}] ✅ Completed in ${Date.now() - startTime}ms (Model: ${validatedRequest.model})`);
        return new Response(JSON.stringify(completion), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      return new Response(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    } catch (error: any) {
      console.error(`[${requestId}] ❌ Error:`, error.message || error);
      let statusCode = 500; let errorType = "internal_server_error"; let errorMessage = "An unexpected server error occurred";

      if (error instanceof ValidationError) {
        statusCode = 400; errorType = "invalid_request_error"; errorMessage = error.message;
      } else if (error.message && (error.message.includes("Rate limited") || error.message.includes("418") || error.message.includes("429"))) {
        statusCode = 429; errorType = "rate_limit_error"; errorMessage = "Rate limit exceeded.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      return new Response(JSON.stringify({ error: { message: errorMessage, type: errorType } }), { status: statusCode, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
  },
});

console.log(`\n🚀 DuckAI OpenAI-compatible server running on http://${server.hostname}:${server.port}\n`);

const shutdown = async () => {
  console.log("\n🛑 Shutting down server gracefully...");
  await openAIService.shutdown();
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
