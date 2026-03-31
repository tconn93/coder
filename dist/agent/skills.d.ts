import type { Skill } from '../types.js';
export declare class SkillsLoader {
    private skills;
    private skillsDir;
    constructor(skillsDir?: string);
    loadAll(): Promise<Skill[]>;
    getAll(): Skill[];
    /**
     * Returns a formatted string summarizing available skills to inject into the system prompt.
     * Only includes name, description, and when_to_use — not full content.
     */
    getSystemPromptAddition(): string;
    /**
     * Returns the full content of a skill by name.
     */
    getSkillContent(name: string): string | null;
}
//# sourceMappingURL=skills.d.ts.map