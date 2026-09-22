/** SSE writing, and the one place that knows how a `BrainEvent` reaches a browser. */

import type { ServerResponse } from 'node:http';
import type { BrainEvent } from './events.js';
import { cors } from './http.js';

export class SseStream {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly res: ServerResponse, heartbeatMs = 15_000) {
    cors(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers event-streams by default, which turns streaming into one
      // delivery at the end. The header costs nothing when no proxy is present.
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(': ping\n\n');
    }, heartbeatMs);
    this.heartbeat.unref?.();
  }

  get isClosed(): boolean { return this.closed; }

  send(event: BrainEvent): void {
    if (this.closed) return;
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.res.end();
  }

  /** Fires when the client hangs up, which is the signal to kill the runner. */
  onClose(fn: () => void): void {
    const run = () => {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.heartbeat);
      fn();
    };
    this.res.on('close', run);
  }
}
