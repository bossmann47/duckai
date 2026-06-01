import { readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface RateLimitData {
  requestTimestamps: number[];
  lastRequestTime: number;
  isLimited: boolean;
  retryAfter?: number;
  lastUpdated: number;
}

export class RateLimitStore {
  private readonly storeFile: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingWrite: Omit<RateLimitData, "lastUpdated"> | null = null;
  private writeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const storeDir = join(tmpdir(), "duckai");
    this.storeFile = join(storeDir, "rate-limit.json");

    if (!existsSync(storeDir)) {
      try {
        mkdirSync(storeDir, { recursive: true });
      } catch (error) {
        console.warn("⚠️ Failed to create rate limit store directory:", error);
      }
    }
  }

  readSync(): RateLimitData | null {
    try {
      if (!existsSync(this.storeFile)) return null;

      const data = readFileSync(this.storeFile, "utf8");
      if (!data.trim()) return null;

      const parsed = JSON.parse(data);

      if (Date.now() - (parsed.lastUpdated || 0) > 5 * 60 * 1000) {
        return null;
      }

      if (!parsed.requestTimestamps && parsed.requestCount !== undefined) {
        return {
          requestTimestamps: [],
          lastRequestTime: parsed.lastRequestTime || 0,
          isLimited: parsed.isLimited || false,
          retryAfter: parsed.retryAfter,
          lastUpdated: parsed.lastUpdated || 0,
        };
      }

      return {
        requestTimestamps: parsed.requestTimestamps || [],
        lastRequestTime: parsed.lastRequestTime || 0,
        isLimited: parsed.isLimited || false,
        retryAfter: parsed.retryAfter,
        lastUpdated: parsed.lastUpdated || 0,
      };
    } catch (error) {
      return null;
    }
  }

  writeAsync(data: Omit<RateLimitData, "lastUpdated">): void {
    this.pendingWrite = data;

    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
    }

    this.writeTimeout = setTimeout(() => {
      this.flushToDisk();
    }, 500);
  }

  private async flushToDisk(): Promise<void> {
    if (!this.pendingWrite) return;

    const dataToWrite = this.pendingWrite;
    this.pendingWrite = null;

    const storeData: RateLimitData = {
      ...dataToWrite,
      lastUpdated: Date.now(),
    };

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await writeFile(this.storeFile, JSON.stringify(storeData, null, 2), "utf8");
      } catch (error) {
        console.warn("⚠️ Failed to write rate limit store to disk:", error);
      }
    });
  }

  async flush(): Promise<void> {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    await this.flushToDisk();
    await this.writeQueue;
  }

  async clear(): Promise<void> {
    try {
      if (existsSync(this.storeFile)) {
        unlinkSync(this.storeFile);
      }
    } catch (error) {
      // Ignore
    }
  }

  getStorePath(): string {
    return this.storeFile;
  }
}
