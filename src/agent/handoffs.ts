import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';

export interface Handoff {
  fromStage: string;
  toStage: string;
  decided: string[];
  rejected: string[];
  risks: string[];
  files: string[];
  remaining: string[];
}

export class HandoffManager {
  private handoffsDir: string;

  constructor(workdir: string) {
    this.handoffsDir = join(workdir, '.coder', 'handoffs');
  }

  async write(handoff: Handoff): Promise<void> {
    await mkdir(this.handoffsDir, { recursive: true });
    const filename = `${handoff.fromStage}-to-${handoff.toStage}.md`;
    const lines = [
      `## Handoff: ${handoff.fromStage} → ${handoff.toStage}`,
      `- **Decided**: ${handoff.decided.join('; ') || 'N/A'}`,
      `- **Rejected**: ${handoff.rejected.join('; ') || 'N/A'}`,
      `- **Risks**: ${handoff.risks.join('; ') || 'N/A'}`,
      `- **Files**: ${handoff.files.join(', ') || 'N/A'}`,
      `- **Remaining**: ${handoff.remaining.join('; ') || 'N/A'}`,
    ];
    await writeFile(join(this.handoffsDir, filename), lines.join('\n'), 'utf-8');
  }

  async read(fromStage: string, toStage: string): Promise<string | null> {
    try {
      return await readFile(join(this.handoffsDir, `${fromStage}-to-${toStage}.md`), 'utf-8');
    } catch { return null; }
  }

  async readAll(): Promise<string> {
    try {
      const files = await readdir(this.handoffsDir);
      const docs = await Promise.all(
        files.filter(f => f.endsWith('.md')).map(f => readFile(join(this.handoffsDir, f), 'utf-8'))
      );
      return docs.join('\n\n---\n\n');
    } catch { return ''; }
  }
}
