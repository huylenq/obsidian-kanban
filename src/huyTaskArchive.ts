export const HUY_TASK_FOLDER = 'Aitomatic/Tasks';
export const HUY_LEGACY_TASK_FOLDER = 'Aitomatic/Backlog';
export const HUY_TASK_BOARD_PATH = 'Aitomatic/Task Kanban.md';
export const HUY_LEGACY_TASK_BOARD_PATH = 'Aitomatic/Backlog Kanban.md';
export const HUY_TASK_ARCHIVE_FOLDER = `${HUY_TASK_FOLDER}/Archive`;
export const HUY_TASK_ARCHIVE_AFTER_DAYS = 14;

export type HuyTaskFrontmatter = Record<string, unknown>;

export function normalizeTaskStatus(value: unknown): string {
  return String(value || 'Inbox').replace(/^[ '\"]+|[ '\"]+$/g, '').trim();
}

export function isDoneTaskStatus(value: unknown): boolean {
  return normalizeTaskStatus(value).toLowerCase() === 'done';
}

function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return null;
  }

  const date = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function taskArchiveBasisDate(frontmatter: HuyTaskFrontmatter): string | null {
  for (const key of ['completed', 'updated', 'created']) {
    const value = frontmatter[key];
    if (parseDateOnly(value)) return String(value).trim();
  }

  return null;
}

export function shouldArchiveDoneTask(
  frontmatter: HuyTaskFrontmatter,
  todayIso: string,
  thresholdDays = HUY_TASK_ARCHIVE_AFTER_DAYS
): boolean {
  if (!isDoneTaskStatus(frontmatter.status)) return false;

  const basis = parseDateOnly(taskArchiveBasisDate(frontmatter));
  const today = parseDateOnly(todayIso);
  if (!basis || !today) return false;

  const ageMs = today.getTime() - basis.getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  return ageDays >= thresholdDays;
}

export function archivePathForTask(path: string, todayIso: string) {
  const fileName = path.split('/').pop() || 'Untitled task.md';
  const year = todayIso.slice(0, 4);
  const folder = `${HUY_TASK_ARCHIVE_FOLDER}/${year}`;
  return { folder, path: `${folder}/${fileName}` };
}
