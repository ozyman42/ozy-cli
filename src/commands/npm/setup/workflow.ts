import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import WORKFLOW_TEMPLATE from './publish-workflow.yml' with { type: 'text' };

const WORKFLOW_PATH = '.github/workflows/publish.yml';

export async function workflowExists(repoRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoRoot, WORKFLOW_PATH));
    return true;
  } catch {
    return false;
  }
}

export async function createWorkflow(repoRoot: string): Promise<void> {
  const fullPath = path.join(repoRoot, WORKFLOW_PATH);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, WORKFLOW_TEMPLATE, 'utf8');
}
