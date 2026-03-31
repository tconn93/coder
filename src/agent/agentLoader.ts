import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, extname } from 'path';
import type { CustomAgentDef } from '../types.js';

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) frontmatter[key] = val;
  }
  return { frontmatter, body: match[2].trim() };
}

export class AgentLoader {
  private agents: CustomAgentDef[] = [];

  constructor(private readonly agentsDir: string) {}

  async loadAll(): Promise<CustomAgentDef[]> {
    this.agents = [];
    try {
      const files = await readdir(this.agentsDir);
      for (const file of files.filter((f) => extname(f) === '.md')) {
        try {
          const content = await readFile(join(this.agentsDir, file), 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);
          if (!frontmatter.name) continue;
          this.agents.push({
            name: frontmatter.name,
            description: frontmatter.description ?? '',
            model: frontmatter.model ?? 'claude-sonnet-4-6',
            tools: frontmatter.tools
              ? frontmatter.tools.split(',').map((t) => t.trim()).filter(Boolean)
              : ['read_file', 'grep', 'glob'],
            systemPrompt: body,
          });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // agentsDir doesn't exist yet
    }
    return this.agents;
  }

  getAll(): CustomAgentDef[] {
    return this.agents;
  }

  async save(agent: CustomAgentDef): Promise<string> {
    await mkdir(this.agentsDir, { recursive: true });
    const slug = agent.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const content = [
      '---',
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `model: ${agent.model}`,
      `tools: ${agent.tools.join(', ')}`,
      '---',
      '',
      agent.systemPrompt,
    ].join('\n');
    const filepath = join(this.agentsDir, `${slug}.md`);
    await writeFile(filepath, content, 'utf-8');
    return filepath;
  }
}
