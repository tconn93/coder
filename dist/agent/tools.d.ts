import { TodoTracker } from './todos.js';
export declare function createBaseTools(workdir: string, todoTracker: TodoTracker): {
    read_file: import("ai").Tool<{
        path: string;
        offset?: number | undefined;
        limit?: number | undefined;
    }, string>;
    write_file: import("ai").Tool<{
        path: string;
        content: string;
    }, string>;
    edit_file: import("ai").Tool<{
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean | undefined;
    }, string>;
    bash: import("ai").Tool<{
        command: string;
        timeout?: number | undefined;
    }, string>;
    glob: import("ai").Tool<{
        pattern: string;
        cwd?: string | undefined;
    }, string>;
    grep: import("ai").Tool<{
        pattern: string;
        path?: string | undefined;
        glob?: string | undefined;
        case_insensitive?: boolean | undefined;
        context?: number | undefined;
    }, string>;
    todo_write: import("ai").Tool<{
        todos: {
            title: string;
            id: string;
            status: "pending" | "in_progress" | "completed";
        }[];
    }, string>;
};
export declare function createTools(workdir: string, todoTracker: TodoTracker, provider: string): {
    spawn_subagent: import("ai").Tool<{
        name: "code-reviewer" | "test-runner" | "file-explorer" | "security-scanner" | "doc-writer";
        prompt: string;
    }, string>;
    read_file: import("ai").Tool<{
        path: string;
        offset?: number | undefined;
        limit?: number | undefined;
    }, string>;
    write_file: import("ai").Tool<{
        path: string;
        content: string;
    }, string>;
    edit_file: import("ai").Tool<{
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean | undefined;
    }, string>;
    bash: import("ai").Tool<{
        command: string;
        timeout?: number | undefined;
    }, string>;
    glob: import("ai").Tool<{
        pattern: string;
        cwd?: string | undefined;
    }, string>;
    grep: import("ai").Tool<{
        pattern: string;
        path?: string | undefined;
        glob?: string | undefined;
        case_insensitive?: boolean | undefined;
        context?: number | undefined;
    }, string>;
    todo_write: import("ai").Tool<{
        todos: {
            title: string;
            id: string;
            status: "pending" | "in_progress" | "completed";
        }[];
    }, string>;
};
//# sourceMappingURL=tools.d.ts.map