import { EventEmitter } from 'events';
import chalk from 'chalk';
import type { TodoItem, TodoStatus } from '../types.js';

export class TodoTracker extends EventEmitter {
  private items: Map<string, TodoItem> = new Map();

  constructor() {
    super();
  }

  /**
   * Parse TodoWrite tool calls from agent messages to track state.
   * The TodoWrite tool takes an array of todos with id, title, status fields.
   */
  parseTodoWrite(toolInput: unknown): void {
    if (!toolInput || typeof toolInput !== 'object') return;

    const input = toolInput as Record<string, unknown>;
    let todos: unknown[] = [];

    if (Array.isArray(input.todos)) {
      todos = input.todos;
    } else if (Array.isArray(input)) {
      todos = input as unknown[];
    }

    let changed = false;

    for (const todo of todos) {
      if (!todo || typeof todo !== 'object') continue;
      const t = todo as Record<string, unknown>;

      const id = String(t.id || '');
      const title = String(t.title || t.content || '');
      const status = (t.status as TodoStatus) || 'pending';

      if (!id || !title) continue;

      const existing = this.items.get(id);

      if (!existing) {
        const newItem: TodoItem = {
          id,
          title,
          status,
          createdAt: new Date(),
          completedAt: status === 'completed' ? new Date() : undefined,
        };
        this.items.set(id, newItem);
        changed = true;
      } else if (existing.status !== status || existing.title !== title) {
        const updatedItem: TodoItem = {
          ...existing,
          title,
          status,
          completedAt:
            status === 'completed' && !existing.completedAt
              ? new Date()
              : existing.completedAt,
        };
        this.items.set(id, updatedItem);
        changed = true;
      }
    }

    if (changed) {
      this.emit('change', this.getAll());
    }
  }

  getAll(): TodoItem[] {
    return Array.from(this.items.values());
  }

  update(id: string, status: TodoStatus): void {
    const item = this.items.get(id);
    if (!item) return;

    const updated: TodoItem = {
      ...item,
      status,
      completedAt:
        status === 'completed' && !item.completedAt ? new Date() : item.completedAt,
    };
    this.items.set(id, updated);
    this.emit('change', this.getAll());
  }

  complete(id: string): void {
    this.update(id, 'completed');
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.emit('change', this.getAll());
    }
  }

  clear(): void {
    this.items.clear();
    this.emit('change', []);
  }

  toDisplay(): string {
    const todos = this.getAll();
    if (todos.length === 0) return '';

    const lines: string[] = [chalk.bold('\n[Todos]')];
    for (const todo of todos) {
      let icon: string;
      let line: string;

      switch (todo.status) {
        case 'completed':
          icon = chalk.green('  ✓');
          line = chalk.green(` ${todo.title}`);
          break;
        case 'in_progress':
          icon = chalk.yellow('  ◉');
          line = chalk.yellow(` ${todo.title}`);
          break;
        default:
          icon = chalk.gray('  ○');
          line = chalk.gray(` ${todo.title}`);
      }

      lines.push(`${icon}${line}`);
    }

    return lines.join('\n');
  }

  getProgress(): { total: number; completed: number; inProgress: number; pending: number } {
    const todos = this.getAll();
    return {
      total: todos.length,
      completed: todos.filter((t) => t.status === 'completed').length,
      inProgress: todos.filter((t) => t.status === 'in_progress').length,
      pending: todos.filter((t) => t.status === 'pending').length,
    };
  }
}
