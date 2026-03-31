import { EventEmitter } from 'events';
import chalk from 'chalk';
export class TodoTracker extends EventEmitter {
    items = new Map();
    constructor() {
        super();
    }
    /**
     * Parse TodoWrite tool calls from agent messages to track state.
     * The TodoWrite tool takes an array of todos with id, title, status fields.
     */
    parseTodoWrite(toolInput) {
        if (!toolInput || typeof toolInput !== 'object')
            return;
        const input = toolInput;
        let todos = [];
        if (Array.isArray(input.todos)) {
            todos = input.todos;
        }
        else if (Array.isArray(input)) {
            todos = input;
        }
        let changed = false;
        for (const todo of todos) {
            if (!todo || typeof todo !== 'object')
                continue;
            const t = todo;
            const id = String(t.id || '');
            const title = String(t.title || t.content || '');
            const status = t.status || 'pending';
            if (!id || !title)
                continue;
            const existing = this.items.get(id);
            if (!existing) {
                const newItem = {
                    id,
                    title,
                    status,
                    createdAt: new Date(),
                    completedAt: status === 'completed' ? new Date() : undefined,
                };
                this.items.set(id, newItem);
                changed = true;
            }
            else if (existing.status !== status || existing.title !== title) {
                const updatedItem = {
                    ...existing,
                    title,
                    status,
                    completedAt: status === 'completed' && !existing.completedAt
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
    getAll() {
        return Array.from(this.items.values());
    }
    update(id, status) {
        const item = this.items.get(id);
        if (!item)
            return;
        const updated = {
            ...item,
            status,
            completedAt: status === 'completed' && !item.completedAt ? new Date() : item.completedAt,
        };
        this.items.set(id, updated);
        this.emit('change', this.getAll());
    }
    complete(id) {
        this.update(id, 'completed');
    }
    remove(id) {
        if (this.items.delete(id)) {
            this.emit('change', this.getAll());
        }
    }
    clear() {
        this.items.clear();
        this.emit('change', []);
    }
    toDisplay() {
        const todos = this.getAll();
        if (todos.length === 0)
            return '';
        const lines = [chalk.bold('\n[Todos]')];
        for (const todo of todos) {
            let icon;
            let line;
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
    getProgress() {
        const todos = this.getAll();
        return {
            total: todos.length,
            completed: todos.filter((t) => t.status === 'completed').length,
            inProgress: todos.filter((t) => t.status === 'in_progress').length,
            pending: todos.filter((t) => t.status === 'pending').length,
        };
    }
}
//# sourceMappingURL=todos.js.map