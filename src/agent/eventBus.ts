/**
 * Typed EventBus for agent lifecycle events.
 *
 * Modeled on Claude Code's hook system. Every agent lifecycle event
 * (session start/end, tool execution, turns, notifications) is published
 * through this bus. Hook subscribers can be blocking (the emitter awaits
 * them) or non-blocking (fire-and-forget).
 *
 * Usage:
 *   const bus = new EventBus();
 *   bus.on('tool.before', async (ctx) => { ... });    // subscribe
 *   const results = await bus.emit('tool.before', ctx); // fire (awaits blocking handlers)
 */
import type { HookContext, HookEventName } from '../types.js';

/** A handler registered for a specific event. */
export type EventHandler = (ctx: HookContext) => Promise<void>;

interface HandlerEntry {
  handler: EventHandler;
  blocking: boolean;
}

export class EventBus {
  private handlers: Map<HookEventName, HandlerEntry[]> = new Map();

  /** Register a handler for an event. Set blocking=true to make emit() await it. */
  on(event: HookEventName, handler: EventHandler, blocking = false): void {
    const list = this.handlers.get(event) ?? [];
    list.push({ handler, blocking });
    this.handlers.set(event, list);
  }

  /** Remove a specific handler from an event. */
  off(event: HookEventName, handler: EventHandler): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.findIndex((e) => e.handler === handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Remove all handlers for an event, or all events if omitted. */
  clear(event?: HookEventName): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Emit an event with context. Returns results from blocking handlers.
   * Non-blocking handlers are fired in the background (not awaited here
   * — they run to completion but this call doesn't wait).
   */
  async emit(event: HookEventName, ctx: HookContext): Promise<string[]> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return [];

    const results: string[] = [];
    const blocking: Promise<void>[] = [];

    for (const { handler, blocking: isBlocking } of list) {
      if (isBlocking) {
        blocking.push(
          handler(ctx).catch((err) => {
            results.push(`Hook error [${event}]: ${(err as Error).message}`);
          }),
        );
      } else {
        // Fire-and-forget: don't block emit(), but still catch errors
        handler(ctx).catch((err) => {
          results.push(`Hook error [${event}]: ${(err as Error).message}`);
        });
      }
    }

    await Promise.all(blocking);
    return results;
  }

  /** Number of registered handlers for an event (or total across all events). */
  count(event?: HookEventName): number {
    if (event) {
      return this.handlers.get(event)?.length ?? 0;
    }
    let total = 0;
    for (const list of this.handlers.values()) total += list.length;
    return total;
  }
}
