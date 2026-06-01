import UserAgent from "user-agents";
import { JSDOM } from "jsdom";
import { RateLimitStore } from "./rate-limit-store";
import { SharedRateLimitMonitor } from "./shared-rate-limit-monitor";
import type { VQDResponse, DuckAIRequest } from "./types";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

interface RateLimitInfo {
  requestTimestamps: number[];
  lastRequestTime: number;
  isLimited: boolean;
  retryAfter?: number;
}

class SSEParser {
  private buffer = "";
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    const messages: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          if (json.message) messages.push(json.message);
        } catch (e) {}
      }
    }
    return messages;
  }
  flush(): string[] {
    const messages: string[] = [];
    const trimmed = this.buffer.trim();
    if (trimmed.startsWith("data: ")) {
      const data = trimmed.slice(6).trim();
      if (data !== "[DONE]") {
        try {
          const json = JSON.parse(data);
          if (json.message) messages.push(json.message);
        } catch (e) {}
      }
    }
    this.buffer = "";
    return messages;
  }
}

export class DuckAI {
  private rateLimitInfo: RateLimitInfo = { requestTimestamps: [], lastRequestTime: 0, isLimited: false };
  private rateLimitStore: RateLimitStore;
  private rateLimitMonitor: SharedRateLimitMonitor;
  private rateLimitLock: Promise<void> = Promise.resolve();

  private readonly MAX_REQUESTS_PER_MINUTE = 20;
  private readonly WINDOW_SIZE_MS = 60 * 1000;
  private readonly MIN_REQUEST_INTERVAL_MS = 500;

  constructor() {
    this.rateLimitStore = new RateLimitStore();
    this.rateLimitMonitor = new SharedRateLimitMonitor();
    this.loadRateLimitFromStore();
  }

  private async acquireRateLimitLock(): Promise<() => void> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => { release = resolve; });
    const currentLock = this.rateLimitLock;
    this.rateLimitLock = nextLock;
    await currentLock;
    return release!;
  }

  private cleanOldTimestamps(): void {
    const now = Date.now();
    const cutoff = now - this.WINDOW_SIZE_MS;
    this.rateLimitInfo.requestTimestamps = this.rateLimitInfo.requestTimestamps.filter((t) => t > cutoff);
  }

  private getCurrentRequestCount(): number {
    this.cleanOldTimestamps();
    return this.rateLimitInfo.requestTimestamps.length;
  }

  private loadRateLimitFromStore(): void {
    const stored = this.rateLimitStore.readSync();
    if (stored) {
      this.rateLimitInfo = {
        requestTimestamps: stored.requestTimestamps || [],
        lastRequestTime: stored.lastRequestTime || 0,
        isLimited: stored.isLimited || false,
        retryAfter: stored.retryAfter,
      };
      this.cleanOldTimestamps();
    }
  }

  private saveRateLimitToStore(): void {
    this.cleanOldTimestamps();
    this.rateLimitStore.writeAsync({
      requestTimestamps: this.rateLimitInfo.requestTimestamps,
      lastRequestTime: this.rateLimitInfo.lastRequestTime,
      isLimited: this.rateLimitInfo.isLimited,
      retryAfter: this.rateLimitInfo.retryAfter,
    });
  }

  getRateLimitStatus() {
    this.loadRateLimitFromStore();
    const now = Date.now();
    const currentRequestCount = this.getCurrentRequestCount();
    const oldestTimestamp = this.rateLimitInfo.requestTimestamps[0];
    const timeUntilReset = oldestTimestamp ? Math.max(0, oldestTimestamp + this.WINDOW_SIZE_MS - now) : 0;
    const timeSinceLastRequest = now - this.rateLimitInfo.lastRequestTime;
    const recommendedWait = Math.max(0, this.MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);

    return {
      requestsInCurrentWindow: currentRequestCount,
      maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE,
      timeUntilWindowReset: timeUntilReset,
      isCurrentlyLimited: this.rateLimitInfo.isLimited,
      recommendedWaitTime: recommendedWait,
    };
  }

  private shouldWaitBeforeRequest(): { shouldWait: boolean; waitTime: number } {
    this.loadRateLimitFromStore();
    const now = Date.now();
    const currentRequestCount = this.getCurrentRequestCount();

    if (currentRequestCount >= this.MAX_REQUESTS_PER_MINUTE) {
      const oldestTimestamp = this.rateLimitInfo.requestTimestamps[0];
      if (oldestTimestamp) {
        const waitTime = oldestTimestamp + this.WINDOW_SIZE_MS - now + 100;
        return { shouldWait: true, waitTime: Math.max(0, waitTime) };
      }
    }

    const timeSinceLastRequest = now - this.rateLimitInfo.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL_MS) {
      return { shouldWait: true, waitTime: this.MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest };
    }

    return { shouldWait: false, waitTime: 0 };
  }

  private async waitIfNeeded(): Promise<void> {
    const { shouldWait, waitTime } = this.shouldWaitBeforeRequest();
    if (shouldWait) {
      console.log(`⏳ Rate limiting: waiting ${waitTime}ms before next request`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  private async getEncodedVqdHash(vqdHash: string, userAgent: string): Promise<string> {
    const jsScript = Buffer.from(vqdHash, 'base64').toString('utf-8');
    const dom = new JSDOM(
      `<iframe id="jsa" sandbox="allow-scripts allow-same-origin" srcdoc="<!DOCTYPE html><html><head><meta http-equiv='Content-Security-Policy' content='default-src \\'none\\'; script-src \\'unsafe-inline\\'></head><body></body></html>" style="position: absolute; left: -9999px; top: -9999px;"></iframe>`,
      { runScripts: 'dangerously' }
    );

    try {
      (dom.window as any).top.__DDG_BE_VERSION__ = 1;
      (dom.window as any).top.__DDG_FE_CHAT_HASH__ = 1;
      const jsa = dom.window.top!.document.querySelector('#jsa') as HTMLIFrameElement;
      const contentDoc = jsa.contentDocument || jsa.contentWindow!.document;

      const meta = contentDoc.createElement('meta');
      meta.setAttribute('http-equiv', 'Content-Security-Policy');
      meta.setAttribute('content', "default-src 'none'; script-src 'unsafe-inline';");
      contentDoc.head.appendChild(meta);

      // 🛡️ AUDIT FIX: Await the promise, but add a fallback to check global window variables
      // in case DuckDuckGo changes their script to assign to window instead of returning.
      let result = await dom.window.eval(jsScript) as any;

      if (!result || !result.client_hashes) {
        result = (dom.window as any).__DDG_HASHES__ || (dom.window as any).client_hashes || result;
      }

      if (!result || !result.client_hashes) {
        throw new Error("Failed to evaluate VQD hash script: result or client_hashes is undefined");
      }

      if (result.client_hashes.length > 0) result.client_hashes[0] = userAgent;

      result.client_hashes = result.client_hashes.map((t: string) => {
        const hash = createHash('sha256');
        hash.update(t);
        return hash.digest('base64');
      });

      return Buffer.from(JSON.stringify(result)).toString('base64');
    } finally {
      dom.window.close();
    }
  }

  private async getVQD(userAgent: string): Promise<VQDResponse> {
    const response = await fetch("https://duckduckgo.com/duckchat/v1/status", {
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-store",
        pragma: "no-cache",
        priority: "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-vqd-accept": "1",
        "User-Agent": userAgent,
      },
      referrer: "https://duckduckgo.com/", method: "GET", mode: "cors", credentials: "include",
    });

    if (!response.ok) throw new Error(`Failed to get VQD: ${response.status}`);
    const hashHeader = response.headers.get("x-vqd-hash-1");
    if (!hashHeader) throw new Error(`Missing VQD headers`);

    const encodedHash = await this.getEncodedVqdHash(hashHeader, userAgent);
    return { hash: encodedHash };
  }

  private async executeRequest(request: DuckAIRequest, maxRetries: number = 2): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const releaseLock = await this.acquireRateLimitLock();
      try {
        if (attempt === 0) await this.waitIfNeeded();
        else await new Promise((resolve) => setTimeout(resolve, 2000));

        const userAgent = new UserAgent().toString();
        const vqd = await this.getVQD(userAgent);

        const now = Date.now();
        this.rateLimitInfo.requestTimestamps.push(now);
        this.rateLimitInfo.lastRequestTime = now;
        this.saveRateLimitToStore();
        this.rateLimitMonitor.printCompactStatus();

        // 🛡️ AUDIT FIX: Restored full browser WAF headers to prevent silent 403/400 blocks
        const response = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
          headers: {
            accept: "text/event-stream",
            "accept-language": "en-US,en;q=0.9",
            "cache-control": "no-cache",
            "content-type": "application/json",
            pragma: "no-cache",
            priority: "u=1, i",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "x-fe-version": "serp_20250401_100419_ET-19d438eb199b2bf7c300",
            "User-Agent": userAgent,
            "x-vqd-hash-1": vqd.hash,
          },
          referrer: "https://duckduckgo.com/",
          body: JSON.stringify(request),
          method: "POST",
        });

        const retryableStatuses = [400, 418, 429, 500, 502, 503, 504];
        if (retryableStatuses.includes(response.status)) {
          if (attempt < maxRetries) {
            const retryAfter = response.headers.get("retry-after");
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 3000;
            console.log(`🔄 [Attempt ${attempt + 1}] Status ${response.status}. Retrying in ${waitTime}ms...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            continue;
          } else {
            if (response.status === 429 || response.status === 418) {
              throw new Error(`Rate limited. Status: ${response.status}`);
            }
            throw new Error(`DuckAI API error: ${response.status}`);
          }
        }

        if (!response.ok) throw new Error(`DuckAI API error: ${response.status}`);
        return response;

      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries && (error instanceof TypeError || error.message.includes("Failed to get VQD"))) {
          console.log(`🔄 [Attempt ${attempt + 1}] Error: ${error.message}. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        break;
      } finally {
        releaseLock();
      }
    }
    throw lastError || new Error("Unknown error in executeRequest()");
  }

  async chat(request: DuckAIRequest, maxRetries: number = 2): Promise<string> {
    const response = await this.executeRequest(request, maxRetries);
    const text = await response.text();

    try {
      const parsed = JSON.parse(text);
      if (parsed.action === "error") throw new Error(`Duck.ai error: ${JSON.stringify(parsed)}`);
    } catch (e) {
      if (e instanceof SyntaxError) { /* Not JSON, continue */ } else throw e;
    }

    const parser = new SSEParser();
    const messages = parser.push(text);
    const finalResponse = messages.join("").trim();

    if (!finalResponse) return "I apologize, but I'm unable to provide a response at the moment.";
    return finalResponse;
  }

  async chatStream(request: DuckAIRequest): Promise<ReadableStream<string>> {
    const response = await this.executeRequest(request);
    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();

    return new ReadableStream<string>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            const remaining = parser.flush();
            for (const msg of remaining) controller.enqueue(msg);
            controller.close();
            return;
          }
          const chunk = decoder.decode(value, { stream: true });
          const messages = parser.push(chunk);
          for (const msg of messages) controller.enqueue(msg);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() { reader.cancel(); }
    });
  }

  getAvailableModels(): string[] {
    return [
      "gpt-4o-mini", "gpt-5-mini", "claude-3-5-haiku-latest",
      "meta-llama/Llama-4-Scout-17B-16E-Instruct", "mistralai/Mistral-Small-24B-Instruct-2501", "openai/gpt-oss-120b"
    ];
  }

  async shutdown(): Promise<void> {
    await this.rateLimitStore.flush();
  }
}
