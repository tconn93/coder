import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

export interface ProjectConfig {
  /** When true, write all LLM request/response data to .coder/convos/<sessionId>.jsonl */
  debugPrompt: boolean;
}

const DEFAULT_CONFIG: ProjectConfig = {
  debugPrompt: false,
};

/**
 * Load project config from <workdir>/.coder/settings.json.
 * Creates the .coder directory and a default settings.json if they don't exist.
 */
export async function loadProjectConfig(workdir: string): Promise<ProjectConfig> {
  const coderDir = join(workdir, '.coder');
  const settingsPath = join(coderDir, 'settings.json');

  // Ensure .coder/ exists
  await mkdir(coderDir, { recursive: true });

  try {
    const raw = await readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
    // Merge with defaults so new config keys are picked up automatically
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // File missing or unparseable — write defaults and return them
    await writeFile(settingsPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    return { ...DEFAULT_CONFIG };
  }
}
