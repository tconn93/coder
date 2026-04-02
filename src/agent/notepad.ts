import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

export class NotepadManager {
  private notepadPath: string;

  constructor(workdir: string) {
    this.notepadPath = join(workdir, '.coder', 'notepad.md');
  }

  async read(): Promise<string> {
    try {
      return await readFile(this.notepadPath, 'utf-8');
    } catch {
      return '';
    }
  }

  async write(content: string, mode: 'replace' | 'append'): Promise<void> {
    await mkdir(dirname(this.notepadPath), { recursive: true });
    if (mode === 'append') {
      const existing = await this.read();
      await writeFile(this.notepadPath, existing + content, 'utf-8');
    } else {
      await writeFile(this.notepadPath, content, 'utf-8');
    }
  }

  async clear(): Promise<void> {
    await mkdir(dirname(this.notepadPath), { recursive: true });
    await writeFile(this.notepadPath, '', 'utf-8');
  }
}
