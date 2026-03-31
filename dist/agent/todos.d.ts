import { EventEmitter } from 'events';
import type { TodoItem, TodoStatus } from '../types.js';
export declare class TodoTracker extends EventEmitter {
    private items;
    constructor();
    /**
     * Parse TodoWrite tool calls from agent messages to track state.
     * The TodoWrite tool takes an array of todos with id, title, status fields.
     */
    parseTodoWrite(toolInput: unknown): void;
    getAll(): TodoItem[];
    update(id: string, status: TodoStatus): void;
    complete(id: string): void;
    remove(id: string): void;
    clear(): void;
    toDisplay(): string;
    getProgress(): {
        total: number;
        completed: number;
        inProgress: number;
        pending: number;
    };
}
//# sourceMappingURL=todos.d.ts.map