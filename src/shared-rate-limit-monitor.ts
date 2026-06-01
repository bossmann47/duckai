import { RateLimitStore } from "./rate-limit-store";

export class SharedRateLimitMonitor {
  private rateLimitStore: RateLimitStore;
  private monitoringInterval?: NodeJS.Timeout;

  private readonly MAX_REQUESTS_PER_MINUTE = 20;
  private readonly WINDOW_SIZE_MS = 60 * 1000;
  private readonly MIN_REQUEST_INTERVAL_MS = 1000;

  constructor() { this.rateLimitStore = new RateLimitStore(); }

  private cleanOldTimestamps(timestamps: number[]): number[] {
    const now = Date.now();
    return timestamps.filter((timestamp) => timestamp > now - this.WINDOW_SIZE_MS);
  }

  getCurrentStatus() {
    const stored = this.rateLimitStore.readSync(); // Updated to readSync
    if (!stored) {
      return { requestsInCurrentWindow: 0, maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE, timeUntilWindowReset: this.WINDOW_SIZE_MS, isCurrentlyLimited: false, recommendedWaitTime: 0, utilizationPercentage: 0, dataSource: "default" as const, lastUpdated: null };
    }

    const now = Date.now();
    const cleanTimestamps = this.cleanOldTimestamps(stored.requestTimestamps || []);
    const requestsInWindow = cleanTimestamps.length;
    const oldestTimestamp = cleanTimestamps[0];
    const timeUntilReset = oldestTimestamp ? Math.max(0, oldestTimestamp + this.WINDOW_SIZE_MS - now) : 0;
    const timeSinceLastRequest = now - stored.lastRequestTime;
    const recommendedWait = Math.max(0, this.MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);
    const utilizationPercentage = (requestsInWindow / this.MAX_REQUESTS_PER_MINUTE) * 100;

    return {
      requestsInCurrentWindow: requestsInWindow, maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE,
      timeUntilWindowReset: Math.max(0, timeUntilReset), isCurrentlyLimited: stored.isLimited,
      recommendedWaitTime: recommendedWait, utilizationPercentage, dataSource: "shared" as const,
      lastUpdated: new Date(stored.lastUpdated).toISOString(), windowType: "sliding" as const,
    };
  }

  printCompactStatus() {
    const status = this.getCurrentStatus();
    const limitIcon = status.isCurrentlyLimited ? "❌" : "✅";
    console.log(`🔄 Rate Limit: ${status.requestsInCurrentWindow}/${status.maxRequestsPerMinute} (${status.utilizationPercentage.toFixed(1)}%) ${limitIcon}`);
  }

  getStoreInfo() {
    const stored = this.rateLimitStore.readSync(); // Updated to readSync
    return { storePath: this.rateLimitStore.getStorePath(), hasData: !!stored, data: stored };
  }
}
