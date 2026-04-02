import { readdir, readFile } from 'fs/promises';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Skill, SkillFrontmatter } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseFrontmatter(content: string): { frontmatter: Partial<SkillFrontmatter>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterStr = match[1];
  const body = match[2];

  const frontmatter: Partial<SkillFrontmatter> = {};

  for (const line of frontmatterStr.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key && value) {
      (frontmatter as Record<string, string>)[key] = value;
    }
  }

  return { frontmatter, body };
}

export class SkillsLoader {
  private skills: Skill[] = [];
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(process.cwd(), 'skills');
  }

  async loadAll(): Promise<Skill[]> {
    this.skills = [];

    try {
      const files = await readdir(this.skillsDir);
      const mdFiles = files.filter((f) => extname(f) === '.md');

      for (const filename of mdFiles) {
        try {
          const filepath = join(this.skillsDir, filename);
          const content = await readFile(filepath, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);

          if (!frontmatter.name) {
            frontmatter.name = filename.replace('.md', '');
          }

          const skill: Skill = {
            frontmatter: {
              name: frontmatter.name || filename.replace('.md', ''),
              description: frontmatter.description || '',
              when_to_use: frontmatter.when_to_use || '',
              keywords: frontmatter.keywords,
            },
            content: body,
            filename,
          };

          this.skills.push(skill);
        } catch {
          // Skip files that can't be read
        }
      }
    } catch {
      // Skills directory doesn't exist or can't be read; that's fine
    }

    return this.skills;
  }

  getAll(): Skill[] {
    return this.skills;
  }

  /**
   * Returns a formatted string summarizing available skills to inject into the system prompt.
   * Only includes name, description, when_to_use, and keywords — not full content.
   */
  getSystemPromptAddition(): string {
    if (this.skills.length === 0) return '';

    const lines: string[] = [
      '\n## Available Skills\n',
      'You have access to the following specialized skills. Load the full skill content when relevant:\n',
    ];

    for (const skill of this.skills) {
      lines.push(`### ${skill.frontmatter.name}`);
      if (skill.frontmatter.description) {
        lines.push(`**Description:** ${skill.frontmatter.description}`);
      }
      if (skill.frontmatter.when_to_use) {
        lines.push(`**When to use:** ${skill.frontmatter.when_to_use}`);
      }
      if (skill.frontmatter.keywords) {
        lines.push(`**Keywords:** ${skill.frontmatter.keywords}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Returns a map of keyword → skill name for auto-triggering skills.
   */
  getKeywordTriggers(): Map<string, string> {
    const map = new Map<string, string>();
    for (const skill of this.skills) {
      if (skill.frontmatter.keywords) {
        for (const kw of skill.frontmatter.keywords.split(',').map(k => k.trim()).filter(Boolean)) {
          map.set(kw.toLowerCase(), skill.frontmatter.name);
        }
      }
    }
    return map;
  }

  /**
   * Returns the full content of a skill by name.
   */
  getSkillContent(name: string): string | null {
    const skill = this.skills.find(
      (s) => s.frontmatter.name.toLowerCase() === name.toLowerCase()
    );
    return skill ? skill.content : null;
  }
}
