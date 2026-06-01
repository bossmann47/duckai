import { DuckAI } from "./duckai";

export class SharedRateLimitTester {
  private duckAI: DuckAI;
  constructor() { this.duckAI = new DuckAI(); }

  async testRateLimits(numberOfRequests: number = 5, delayBetweenRequests: number = 1000) {
    console.log(`🧪 Testing rate limits with ${numberOfRequests} requests...`);
    for (let i = 1; i <= numberOfRequests; i++) {
      try {
        await this.duckAI.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: `Test ${i}` }] });
        console.log(`✅ Request ${i} successful`);
      } catch (error) {
        console.log(`❌ Request ${i} failed:`, error instanceof Error ? error.message : String(error));
      }
      if (i < numberOfRequests) await new Promise((resolve) => setTimeout(resolve, delayBetweenRequests));
    }
  }
}
