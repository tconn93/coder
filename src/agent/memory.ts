import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  file: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return { frontmatter, body: match[2].trim() };
}

export class MemoryManager {
  private entries: MemoryEntry[] = [];
  private memoryDir: string;

  constructor(workdir: string) {
    this.memoryDir = join(workdir, '.coder', 'memory');
  }

  async load(): Promise<MemoryEntry[]> {
    try {
      const files = await readdir(this.memoryDir);
      const mdFiles = files.filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      const loaded: MemoryEntry[] = [];
      for (const file of mdFiles) {
        try {
          const raw = await readFile(join(this.memoryDir, file), 'utf-8');
          const { frontmatter, body } = parseFrontmatter(raw);
          if (frontmatter.name && frontmatter.type) {
            loaded.push({
              name: frontmatter.name,
              description: frontmatter.description ?? '',
              type: frontmatter.type as MemoryType,
              body,
              file,
            });
          }
        } catch {
          // skip unreadable files
        }
      }
      this.entries = loaded;
    } catch {
      // directory doesn't exist yet
      this.entries = [];
    }
    return this.entries;
  }

  async write(entry: Omit<MemoryEntry, 'file'>): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    const slug = slugify(entry.name);
    const filename = `${slug}.md`;
    const filePath = join(this.memoryDir, filename);
    const content = `---\nname: ${entry.name}\ndescription: ${entry.description}\ntype: ${entry.type}\n---\n\n${entry.body}\n`;
    await writeFile(filePath, content, 'utf-8');

    // Update in-memory cache
    const existing = this.entries.findIndex((e) => e.file === filename);
    const newEntry: MemoryEntry = { ...entry, file: filename };
    if (existing >= 0) {
      this.entries[existing] = newEntry;
    } else {
      this.entries.push(newEntry);
    }

    // Rebuild MEMORY.md index
    await this.rebuildIndex();
  }

  private async rebuildIndex(): Promise<void> {
    const lines = this.entries.map((e) => `- [${e.name}](${e.file}) — ${e.description}`);
    const content = lines.join('\n') + '\n';
    await writeFile(join(this.memoryDir, 'MEMORY.md'), content, 'utf-8');
  }

  async list(): Promise<MemoryEntry[]> {
    return this.entries;
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    return this.entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q),
    );
  }

  getSummary(): string {
    if (this.entries.length === 0) return '';
    const lines = this.entries.map((e) => `- [${e.name}](${e.file}) — ${e.description}`);
    return lines.join('\n');
  }
}
