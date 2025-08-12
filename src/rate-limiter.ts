import { sleep } from './utils';

interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize: number;
  adaptiveBackoff: boolean;
}

interface QueuedRequest {
  fn: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  priority: number;
  retryCount: number;
}

export class NotionRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: QueuedRequest[] = [];
  private processing = false;
  private consecutive429s = 0;
  private baseDelay: number;
  
  constructor(private config: RateLimitConfig = {
    requestsPerSecond: 2.5, // Conservative rate under Notion's 3/sec limit
    burstSize: 5,
    adaptiveBackoff: true
  }) {
    this.tokens = config.burstSize;
    this.lastRefill = Date.now();
    this.baseDelay = 1000 / config.requestsPerSecond;
  }

  async execute<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        fn,
        resolve,
        reject,
        priority,
        retryCount: 0
      });
      
      // Sort queue by priority (higher priority first)
      this.queue.sort((a, b) => b.priority - a.priority);
      
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      // Refill tokens based on time elapsed
      this.refillTokens();

      // Wait if no tokens available
      if (this.tokens < 1) {
        const waitTime = this.baseDelay * (this.consecutive429s > 0 ? Math.pow(2, Math.min(this.consecutive429s, 4)) : 1);
        console.log(`Rate limiter: waiting ${waitTime}ms for token refill`);
        await sleep(waitTime);
        continue;
      }

      const request = this.queue.shift()!;
      this.tokens--;

      try {
        const result = await request.fn();
        this.consecutive429s = 0; // Reset on success
        request.resolve(result);
      } catch (error: any) {
        if (error.status === 429 || error.message?.includes('429')) {
          this.consecutive429s++;
          request.retryCount++;
          
          if (request.retryCount < 6) {
            // Re-queue with lower priority
            this.queue.unshift({ ...request, priority: request.priority - 1 });
            console.log(`Rate limiter: 429 detected, requeuing request (attempt ${request.retryCount})`);
            
            // Adaptive backoff - reduce token refill rate temporarily
            if (this.config.adaptiveBackoff) {
              const backoffDelay = Math.min(10000, 2000 * Math.pow(2, this.consecutive429s - 1));
              console.log(`Rate limiter: adaptive backoff ${backoffDelay}ms`);
              await sleep(backoffDelay);
            }
          } else {
            request.reject(error);
          }
        } else {
          request.reject(error);
        }
      }

      // Small delay between requests even when tokens are available
      await sleep(50);
    }

    this.processing = false;
  }

  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const tokensToAdd = (timePassed / 1000) * this.config.requestsPerSecond;
    
    this.tokens = Math.min(this.config.burstSize, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  getQueueStatus(): { queueLength: number; tokens: number; consecutive429s: number } {
    return {
      queueLength: this.queue.length,
      tokens: this.tokens,
      consecutive429s: this.consecutive429s
    };
  }
}
