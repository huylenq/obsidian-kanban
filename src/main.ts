import { around } from 'monkey-around';
import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  ViewState,
  WorkspaceLeaf,
  debounce,
} from 'obsidian';
import { render, unmountComponentAtNode, useEffect, useState } from 'preact/compat';

import { createApp } from './DragDropApp';
import { KanbanView, kanbanIcon, kanbanViewType } from './KanbanView';
import { KanbanSettings, KanbanSettingsTab } from './Settings';
import { StateManager } from './StateManager';
import { DateSuggest, TimeSuggest } from './components/Editor/suggest';
import { getParentWindow } from './dnd/util/getWindow';
import { hasFrontmatterKey } from './helpers';
import { t } from './lang/helpers';
import { basicFrontmatter, frontmatterKey } from './parsers/common';

interface WindowRegistry {
  viewMap: Map<string, KanbanView>;
  viewStateReceivers: Array<(views: KanbanView[]) => void>;
  appRoot: HTMLElement;
}

const HUY_BACKLOG_FOLDER = 'Aitomatic/Backlog';
const HUY_BACKLOG_BOARD_PATH = 'Aitomatic/Backlog Kanban.md';

interface HuyBacklogTask {
  path: string;
  basename: string;
  title: string;
  status: string;
  tags: string[];
  backlogId: string;
}

function normalizeFrontmatterList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeInlineTag(tag: string): string | null {
  const normalized = tag
    .replace(/^#+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}/_-]/gu, '');

  return normalized ? `#${normalized}` : null;
}

function sortStatuses(statuses: string[]): string[] {
  const order = ['Active', 'In Progress', 'Todo', 'Backlog', 'Waiting', 'Blocked', 'Done', 'Canceled', 'Cancelled'];

  return statuses.sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);

    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
    }

    return a.localeCompare(b);
  });
}

function getEditorClass(app: any) {
  const md = app.embedRegistry.embedByExtension.md(
    { app: app, containerEl: createDiv(), state: {} },
    null,
    ''
  );

  md.load();
  md.editable = true;
  md.showEditor();

  const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor;

  md.unload();

  return MarkdownEditor;
}

export default class KanbanPlugin extends Plugin {
  settingsTab: KanbanSettingsTab;
  settings: KanbanSettings = {};

  // leafid => view mode
  kanbanFileModes: Record<string, string> = {};
  stateManagers: Map<TFile, StateManager> = new Map();

  windowRegistry: Map<Window, WindowRegistry> = new Map();

  _loaded: boolean = false;

  isShiftPressed: boolean = false;

  async loadSettings() {
    this.settings = Object.assign({}, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  unload(): void {
    super.unload();
    Promise.all(
      this.app.workspace.getLeavesOfType(kanbanViewType).map((leaf) => {
        this.kanbanFileModes[(leaf as any).id] = 'markdown';
        return this.setMarkdownView(leaf);
      })
    );
  }

  onunload() {
    this.MarkdownEditor = null;
    this.windowRegistry.forEach((reg, win) => {
      reg.viewStateReceivers.forEach((fn) => fn([]));
      this.unmount(win);
    });

    this.unmount(window);

    this.stateManagers.clear();
    this.windowRegistry.clear();
    this.kanbanFileModes = {};

    (this.app.workspace as any).unregisterHoverLinkSource(frontmatterKey);
  }

  MarkdownEditor: any;

  async onload() {
    await this.writeHuyForkLoadMarker('onload-start');
    await this.loadSettings();

    this.MarkdownEditor = getEditorClass(this.app);

    this.registerEditorSuggest(new TimeSuggest(this.app, this));
    this.registerEditorSuggest(new DateSuggest(this.app, this));

    this.registerEvent(
      this.app.workspace.on('window-open', (_: any, win: Window) => {
        this.mount(win);
      })
    );

    this.registerEvent(
      this.app.workspace.on('window-close', (_: any, win: Window) => {
        this.unmount(win);
      })
    );

    this.settingsTab = new KanbanSettingsTab(this, {
      onSettingsChange: async (newSettings) => {
        this.settings = newSettings;
        await this.saveSettings();

        // Force a complete re-render when settings change
        this.stateManagers.forEach((stateManager) => {
          stateManager.forceRefresh();
        });
      },
    });

    this.addSettingTab(this.settingsTab);

    this.registerView(kanbanViewType, (leaf) => new KanbanView(leaf, this));
    this.registerMonkeyPatches();
    this.registerCommands();
    this.registerEvents();

    // Mount an empty component to start; views will be added as we go
    this.mount(window);

    (this.app.workspace as any).floatingSplit?.children?.forEach((c: any) => {
      this.mount(c.win);
    });

    this.registerDomEvent(window, 'keydown', this.handleShift);
    this.registerDomEvent(window, 'keyup', this.handleShift);

    this.addRibbonIcon(kanbanIcon, t('Create new board'), () => {
      this.newKanban();
    });

    this.writeHuyForkLoadMarker('onload-end');
  }

  async writeHuyForkLoadMarker(phase: string = 'loaded') {
    try {
      await this.app.vault.adapter.write(
        '.obsidian/plugins/obsidian-kanban/huy-load-marker.txt',
        `Huy fork ${phase} at ${new Date().toISOString()}\n`
      );
    } catch (e) {
      console.error('Unable to write Huy fork load marker:', e);
    }
  }

  handleShift = (e: KeyboardEvent) => {
    this.isShiftPressed = e.shiftKey;
  };

  isHuyBacklogFile(file: unknown) {
    return file instanceof TFile && file.extension === 'md' && file.path.startsWith(`${HUY_BACKLOG_FOLDER}/`);
  }

  async syncHuyBacklogKanban(showNotice: boolean = true) {
    if (this._isSyncingHuyBacklog) return;
    this._isSyncingHuyBacklog = true;
    try {
      const existingBoard = this.app.vault.getAbstractFileByPath(HUY_BACKLOG_BOARD_PATH);
      if (existingBoard instanceof TFile) {
        const currentBoard = await this.app.vault.read(existingBoard);
        // updateStatuses=false: source file is truth here; board position must not
        // overwrite a status that the user changed directly in the note.
        // This call's only purpose is to flush any plain-text Add Card entries into
        // real files before the full rebuild below enumerates the folder.
        await this.prepareHuyBacklogKanbanForSave(existingBoard, currentBoard, false, false);
      }

      const folder = this.app.vault.getAbstractFileByPath(HUY_BACKLOG_FOLDER);

      if (!(folder instanceof TFolder)) {
        if (showNotice) new Notice(`Backlog folder not found: ${HUY_BACKLOG_FOLDER}`);
        return;
      }

      const tasks: HuyBacklogTask[] = [];
      for (const file of folder.children.filter(
        (child): child is TFile => child instanceof TFile && child.extension === 'md'
      )) {
        const backlogId = await this.ensureBacklogId(file);
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const title = String(frontmatter.title || file.basename).replace(/^['\"]|['\"]$/g, '').trim();
        const status = String(frontmatter.status || 'Backlog').replace(/^['\"]|['\"]$/g, '').trim();
        const tags = normalizeFrontmatterList(frontmatter.tags)
          .map(normalizeInlineTag)
          .filter((tag): tag is string => !!tag);

        tasks.push({
          path: file.path,
          basename: file.basename,
          title,
          status,
          tags,
          backlogId,
        });
      }

      tasks.sort((a, b) => a.title.localeCompare(b.title));

      const statuses = sortStatuses(Array.from(new Set(tasks.map((task) => task.status))));
      const lines: string[] = [
        '---',
        'kanban-plugin: board',
        'tags:',
        '  - aitomatic/backlog',
        '  - kanban',
        '---',
        '',
      ];

      for (const status of statuses) {
        lines.push(`## ${status}`, '');

        const statusTasks = tasks.filter((task) => task.status === status);
        for (const task of statusTasks) {
          const tags = task.tags.length ? ` ${task.tags.join(' ')}` : '';
          lines.push(`- [ ] [[Backlog/${task.basename}|${task.title}]]${tags} <!--backlog-id: ${task.backlogId}-->`);
        }

        lines.push('');
      }

      lines.push(
        '%% kanban:settings',
        '```',
        JSON.stringify({
          'kanban-plugin': 'board',
          'list-collapse': statuses.map(() => false),
          'new-card-insertion-method': 'prepend',
          'show-checkboxes': true,
          'link-date-to-daily-note': false,
        }),
        '```',
        '%%',
        ''
      );

      const content = lines.join('\n');
      const existing = this.app.vault.getAbstractFileByPath(HUY_BACKLOG_BOARD_PATH);

      if (existing instanceof TFile) {
        const current = await this.app.vault.read(existing);
        if (current !== content) {
          await this.app.vault.modify(existing, content);
        }
      } else {
        await this.app.vault.create(HUY_BACKLOG_BOARD_PATH, content);
      }

      if (showNotice) new Notice(`Synced ${tasks.length} backlog tasks to Backlog Kanban`);
    } catch (e) {
      console.error('Error syncing Huy backlog kanban:', e);
      if (showNotice) new Notice(`Backlog Kanban sync failed: ${e}`);
    } finally {
      this._isSyncingHuyBacklog = false;
    }
  }

  syncHuyBacklogKanbanDebounced = debounce(
    () => this.syncHuyBacklogKanban(false),
    1000,
    true
  );

  isHuyBacklogKanbanBoard(file: TFile | null | undefined) {
    return file instanceof TFile && file.path === HUY_BACKLOG_BOARD_PATH;
  }

  stripInlineTags(text: string) {
    return text.replace(/(^|\s)#[\p{L}\p{N}/_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  extractInlineTags(text: string) {
    const tags: string[] = [];
    const regex = /(^|\s)#([\p{L}\p{N}/_-]+)/gu;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      tags.push(match[2]);
    }

    return tags;
  }

  stripMarkdownLinks(text: string) {
    return text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .trim();
  }

  sanitizeBacklogFilename(title: string) {
    const sanitized = title
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/#+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return sanitized || 'Untitled backlog task';
  }

  yamlString(value: string) {
    return JSON.stringify(value);
  }

  generateBacklogId() {
    return `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getBacklogIdFromCard(text: string) {
    return text.match(/<!--\s*backlog-id:\s*([^\s>]+)\s*-->/)?.[1] || null;
  }

  stripBacklogIdComment(text: string) {
    return text.replace(/\s*<!--\s*backlog-id:\s*[^\s>]+\s*-->/g, '').trim();
  }

  getBacklogLinkPath(text: string) {
    const link = text.match(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/)?.[1];
    if (!link) return null;

    const normalized = link.replace(/\.md$/, '');
    if (normalized.startsWith('Backlog/')) {
      return `${HUY_BACKLOG_FOLDER}/${normalized.slice('Backlog/'.length)}.md`;
    }

    if (normalized.startsWith(`${HUY_BACKLOG_FOLDER}/`)) {
      return `${normalized}.md`;
    }

    return null;
  }

  findBacklogFileById(backlogId: string) {
    const folder = this.app.vault.getAbstractFileByPath(HUY_BACKLOG_FOLDER);
    if (!(folder instanceof TFolder)) return null;

    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== 'md') continue;
      const frontmatter = this.app.metadataCache.getFileCache(child)?.frontmatter || {};
      if (frontmatter.backlog_id === backlogId) return child;
    }

    return null;
  }

  async ensureBacklogId(file: TFile) {
    // Fast path: trust the cache when it has an ID.
    const cachedId = this.app.metadataCache.getFileCache(file)?.frontmatter?.backlog_id;
    if (typeof cachedId === 'string' && cachedId.trim()) return cachedId.trim();

    // Slow path: read actual frontmatter so we never overwrite an ID that exists on
    // disk but hasn't propagated to the cache yet (e.g., right after a rename).
    let assignedId = '';
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const existing = frontmatter.backlog_id;
      if (typeof existing === 'string' && existing.trim()) {
        assignedId = existing.trim();
      } else {
        assignedId = this.generateBacklogId();
        frontmatter.backlog_id = assignedId;
      }
    });

    return assignedId;
  }

  async maybeUpdateBacklogStatus(file: TFile, newStatus: string) {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const currentStatus = String(frontmatter.status || 'Backlog').replace(/^['\"]|['\"]$/g, '').trim();
    if (currentStatus === newStatus) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.status = newStatus;
    });
  }

  async rewriteBacklogCardForFile(rawTitle: string, file: TFile, check: string, indent: string) {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const title = String(frontmatter.title || file.basename).replace(/^['\"]|['\"]$/g, '').trim() || file.basename;
    const tags = normalizeFrontmatterList(frontmatter.tags)
      .map(normalizeInlineTag)
      .filter((tag): tag is string => !!tag);
    const backlinkId = await this.ensureBacklogId(file);
    const inlineTags = tags.length ? ` ${tags.join(' ')}` : '';

    return `${indent}- [${check}] [[Backlog/${file.basename}|${title}]]${inlineTags} <!--backlog-id: ${backlinkId}-->`;
  }

  async uniqueBacklogPath(title: string) {
    const base = this.sanitizeBacklogFilename(title);
    let candidate = `${HUY_BACKLOG_FOLDER}/${base}.md`;
    let suffix = 2;

    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${HUY_BACKLOG_FOLDER}/${base} ${suffix}.md`;
      suffix += 1;
    }

    return candidate;
  }

  async createBacklogTaskFromKanbanCard(title: string, status: string, tags: string[]) {
    const path = await this.uniqueBacklogPath(title);
    const backlogId = this.generateBacklogId();
    const created = new Date().toISOString().slice(0, 10);
    const tagLines = tags.length ? tags.map((tag) => `  - ${this.yamlString(tag)}`).join('\n') : '';
    const content = [
      '---',
      `title: ${this.yamlString(title)}`,
      `status: ${this.yamlString(status)}`,
      `backlog_id: ${this.yamlString(backlogId)}`,
      'projects:',
      '  - "[[Projects/HON/Index]]"',
      ...(tags.length ? ['tags:', tagLines] : []),
      `created: ${this.yamlString(created)}`,
      'origin:',
      `  - "[[${HUY_BACKLOG_BOARD_PATH.replace(/\.md$/, '')}]]"`,
      '---',
      '',
      '## Context',
      '',
      `Created from [[${HUY_BACKLOG_BOARD_PATH.replace(/\.md$/, '')}]] via Kanban Add Card.`,
      '',
    ].join('\n');

    await this.app.vault.create(path, content);

    return {
      linkPath: path.replace(/\.md$/, '').replace(`${HUY_BACKLOG_FOLDER}/`, 'Backlog/'),
      backlogId,
    };
  }

  // When true, prevents syncHuyBacklogKanban from re-entering itself via vault events
  // triggered by ensureBacklogId / maybeUpdateBacklogStatus writes during a sync.
  _isSyncingHuyBacklog = false;

  async prepareHuyBacklogKanbanForSave(
    file: TFile | null | undefined,
    data: string,
    showNotice: boolean = true,
    // updateStatuses=false when called from syncHuyBacklogKanban so that source-file
    // status always wins over stale board position during a full rebuild.
    updateStatuses: boolean = true
  ) {
    if (!this.isHuyBacklogKanbanBoard(file)) return data;

    const output: string[] = [];
    const seenBacklogIds = new Set<string>();
    let currentStatus = 'Backlog';
    let createdCount = 0;
    let removedCount = 0;

    for (const line of data.split('\n')) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        currentStatus = heading[1].trim();
        output.push(line);
        continue;
      }

      const card = line.match(/^(\s*)- \[([ xX-])\]\s+(.+?)\s*$/);
      if (!card) {
        output.push(line);
        continue;
      }

      const [, indent, check, rawTitle] = card;
      const cleanRawTitle = this.stripBacklogIdComment(rawTitle);
      const existingBacklogId = this.getBacklogIdFromCard(rawTitle);

      if (existingBacklogId) {
        if (seenBacklogIds.has(existingBacklogId)) {
          removedCount += 1;
          continue;
        }

        const linkedFile = this.findBacklogFileById(existingBacklogId);
        if (linkedFile) {
          seenBacklogIds.add(existingBacklogId);
          if (updateStatuses) await this.maybeUpdateBacklogStatus(linkedFile, currentStatus);
          output.push(await this.rewriteBacklogCardForFile(cleanRawTitle, linkedFile, check, indent));
          continue;
        }

        // Card had a stable backlog_id but its file no longer exists → user deleted the
        // source note. Do not resurrect it.
        removedCount += 1;
        continue;
      }

      const linkedPath = this.getBacklogLinkPath(cleanRawTitle);
      if (linkedPath) {
        const linked = this.app.vault.getAbstractFileByPath(linkedPath);
        if (linked instanceof TFile) {
          if (updateStatuses) await this.maybeUpdateBacklogStatus(linked, currentStatus);
          output.push(await this.rewriteBacklogCardForFile(cleanRawTitle, linked, check, indent));
          continue;
        }

        // Broken Backlog wikilink with no matching file → stale reference, not new input.
        removedCount += 1;
        continue;
      }

      const titleWithoutTags = this.stripInlineTags(cleanRawTitle);
      const plainTitle = this.stripMarkdownLinks(titleWithoutTags).trim();
      if (!plainTitle) {
        output.push(line);
        continue;
      }

      const tags = this.extractInlineTags(cleanRawTitle);
      const backlog = await this.createBacklogTaskFromKanbanCard(plainTitle, currentStatus, tags);
      const inlineTags = tags.map((tag) => `#${tag}`).join(' ');
      const suffix = inlineTags ? ` ${inlineTags}` : '';
      output.push(`${indent}- [${check}] [[${backlog.linkPath}|${plainTitle}]]${suffix} <!--backlog-id: ${backlog.backlogId}-->`);
      createdCount += 1;
    }

    if (showNotice && (createdCount > 0 || removedCount > 0)) {
      const parts: string[] = [];
      if (createdCount > 0) {
        parts.push(`created ${createdCount} backlog task file${createdCount === 1 ? '' : 's'}`);
      }
      if (removedCount > 0) {
        parts.push(`removed ${removedCount} stale/duplicate card${removedCount === 1 ? '' : 's'}`);
      }
      new Notice(`Huy Backlog Kanban: ${parts.join(', ')}`);
    }

    return output.join('\n');
  }

  getKanbanViews(win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg) {
      return Array.from(reg.viewMap.values());
    }

    return [];
  }

  getKanbanView(id: string, win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg?.viewMap.has(id)) {
      return reg.viewMap.get(id);
    }

    for (const reg of this.windowRegistry.values()) {
      if (reg.viewMap.has(id)) {
        return reg.viewMap.get(id);
      }
    }

    return null;
  }

  getStateManager(file: TFile) {
    return this.stateManagers.get(file);
  }

  getStateManagerFromViewID(id: string, win: Window) {
    const view = this.getKanbanView(id, win);

    if (!view) {
      return null;
    }

    return this.stateManagers.get(view.file);
  }

  useKanbanViews(win: Window): KanbanView[] {
    const [state, setState] = useState(this.getKanbanViews(win));

    useEffect(() => {
      const reg = this.windowRegistry.get(win);

      reg?.viewStateReceivers.push(setState);

      return () => {
        reg?.viewStateReceivers.remove(setState);
      };
    }, [win]);

    return state;
  }

  addView(view: KanbanView, data: string, shouldParseData: boolean) {
    const win = view.getWindow();
    const reg = this.windowRegistry.get(win);

    if (!reg) return;
    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    const file = view.file;

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).registerView(view, data, shouldParseData);
    } else {
      this.stateManagers.set(
        file,
        new StateManager(
          this.app,
          view,
          data,
          () => this.stateManagers.delete(file),
          () => this.settings
        )
      );
    }

    reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));
  }

  removeView(view: KanbanView) {
    const entry = Array.from(this.windowRegistry.entries()).find(([, reg]) => {
      return reg.viewMap.has(view.id);
    }, []);

    if (!entry) return;

    const [win, reg] = entry;
    const file = view.file;

    if (reg.viewMap.has(view.id)) {
      reg.viewMap.delete(view.id);
    }

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).unregisterView(view);
      reg.viewStateReceivers.forEach((fn) => fn(this.getKanbanViews(win)));
    }
  }

  handleViewFileRename(view: KanbanView, oldPath: string) {
    const win = view.getWindow();
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);
    const oldId = `${(view.leaf as any).id}:::${oldPath}`;

    if (reg.viewMap.has(oldId)) {
      reg.viewMap.delete(oldId);
    }

    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    if (view.isPrimary) {
      this.getStateManager(view.file).softRefresh();
    }
  }

  mount(win: Window) {
    if (this.windowRegistry.has(win)) {
      return;
    }

    const el = win.document.body.createDiv();

    this.windowRegistry.set(win, {
      viewMap: new Map(),
      viewStateReceivers: [],
      appRoot: el,
    });

    render(createApp(win, this), el);
  }

  unmount(win: Window) {
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);

    for (const view of reg.viewMap.values()) {
      this.removeView(view);
    }

    unmountComponentAtNode(reg.appRoot);

    reg.appRoot.remove();
    reg.viewMap.clear();
    reg.viewStateReceivers.length = 0;
    reg.appRoot = null;

    this.windowRegistry.delete(win);
  }

  async setMarkdownView(leaf: WorkspaceLeaf, focus: boolean = true) {
    await leaf.setViewState(
      {
        type: 'markdown',
        state: leaf.view.getState(),
        popstate: true,
      } as ViewState,
      { focus }
    );
  }

  async setKanbanView(leaf: WorkspaceLeaf) {
    await leaf.setViewState({
      type: kanbanViewType,
      state: leaf.view.getState(),
      popstate: true,
    } as ViewState);
  }

  async newKanban(folder?: TFolder) {
    const targetFolder = folder
      ? folder
      : this.app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path || '');

    try {
      const kanban: TFile = await (app.fileManager as any).createNewMarkdownFile(
        targetFolder,
        t('Untitled Kanban')
      );

      await this.app.vault.modify(kanban, basicFrontmatter);
      await this.app.workspace.getLeaf().setViewState({
        type: kanbanViewType,
        state: { file: kanban.path },
      });
    } catch (e) {
      console.error('Error creating kanban board:', e);
    }
  }

  registerEvents() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        if (source === 'link-context-menu') return;

        const fileIsFile = file instanceof TFile;
        const fileIsFolder = file instanceof TFolder;
        const leafIsMarkdown = leaf?.view instanceof MarkdownView;
        const leafIsKanban = leaf?.view instanceof KanbanView;

        // Add a menu item to the folder context menu to create a board
        if (fileIsFolder) {
          menu.addItem((item) => {
            item
              .setSection('action-primary')
              .setTitle(t('New kanban board'))
              .setIcon(kanbanIcon)
              .onClick(() => this.newKanban(file));
          });
          return;
        }

        if (
          !Platform.isMobile &&
          fileIsFile &&
          leaf &&
          source === 'sidebar-context-menu' &&
          hasFrontmatterKey(file)
        ) {
          const views = this.getKanbanViews(getParentWindow(leaf.view.containerEl));
          let haveKanbanView = false;

          for (const view of views) {
            if (view.file === file) {
              view.onPaneMenu(menu, 'more-options', false);
              haveKanbanView = true;
              break;
            }
          }

          if (!haveKanbanView) {
            menu.addItem((item) => {
              item
                .setTitle(t('Open as kanban board'))
                .setIcon(kanbanIcon)
                .setSection('pane')
                .onClick(() => {
                  this.kanbanFileModes[(leaf as any).id || file.path] = kanbanViewType;
                  this.setKanbanView(leaf);
                });
            });

            return;
          }
        }

        if (
          leafIsMarkdown &&
          fileIsFile &&
          ['more-options', 'pane-more-options', 'tab-header'].includes(source) &&
          hasFrontmatterKey(file)
        ) {
          menu.addItem((item) => {
            item
              .setTitle(t('Open as kanban board'))
              .setIcon(kanbanIcon)
              .setSection('pane')
              .onClick(() => {
                this.kanbanFileModes[(leaf as any).id || file.path] = kanbanViewType;
                this.setKanbanView(leaf);
              });
          });
        }

        if (fileIsFile && leafIsKanban) {
          if (['pane-more-options', 'tab-header'].includes(source)) {
            menu.addItem((item) => {
              item
                .setTitle(t('Open as markdown'))
                .setIcon(kanbanIcon)
                .setSection('pane')
                .onClick(() => {
                  this.kanbanFileModes[(leaf as any).id || file.path] = 'markdown';
                  this.setMarkdownView(leaf);
                });
            });
          }

          if (Platform.isMobile) {
            const stateManager = this.stateManagers.get(file);
            const kanbanView = leaf.view as KanbanView;
            const boardView =
              kanbanView.viewSettings[frontmatterKey] || stateManager.getSetting(frontmatterKey);

            menu
              .addItem((item) => {
                item
                  .setTitle(t('Add a list'))
                  .setIcon('lucide-plus-circle')
                  .setSection('pane')
                  .onClick(() => {
                    kanbanView.emitter.emit('showLaneForm', undefined);
                  });
              })
              .addItem((item) => {
                item
                  .setTitle(t('Archive completed cards'))
                  .setIcon('lucide-archive')
                  .setSection('pane')
                  .onClick(() => {
                    stateManager.archiveCompletedCards();
                  });
              })
              .addItem((item) => {
                item
                  .setTitle(t('Archive completed cards'))
                  .setIcon('lucide-archive')
                  .setSection('pane')
                  .onClick(() => {
                    const stateManager = this.stateManagers.get(file);
                    stateManager.archiveCompletedCards();
                  });
              })
              .addItem((item) =>
                item
                  .setTitle(t('View as board'))
                  .setSection('pane')
                  .setIcon('lucide-trello')
                  .setChecked(boardView === 'basic' || boardView === 'board')
                  .onClick(() => kanbanView.setView('board'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('View as table'))
                  .setSection('pane')
                  .setIcon('lucide-table')
                  .setChecked(boardView === 'table')
                  .onClick(() => kanbanView.setView('table'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('View as list'))
                  .setSection('pane')
                  .setIcon('lucide-server')
                  .setChecked(boardView === 'list')
                  .onClick(() => kanbanView.setView('list'))
              )
              .addItem((item) =>
                item
                  .setTitle(t('Open board settings'))
                  .setSection('pane')
                  .setIcon('lucide-settings')
                  .onClick(() => kanbanView.getBoardSettings())
              );
          }
        }
      })
    );

    this.registerEvent(
      app.vault.on('rename', (file, oldPath) => {
        const kanbanLeaves = app.workspace.getLeavesOfType(kanbanViewType);

        kanbanLeaves.forEach((leaf) => {
          (leaf.view as KanbanView).handleRename(file.path, oldPath);
        });

        if (this.isHuyBacklogFile(file) || oldPath.startsWith(`${HUY_BACKLOG_FOLDER}/`)) {
          this.syncHuyBacklogKanbanDebounced();
        }
      })
    );

    this.registerEvent(
      app.vault.on('create', (file) => {
        if (this.isHuyBacklogFile(file)) {
          this.syncHuyBacklogKanbanDebounced();
        }
      })
    );

    this.registerEvent(
      app.vault.on('delete', (file) => {
        if (this.isHuyBacklogFile(file)) {
          this.syncHuyBacklogKanbanDebounced();
        }
      })
    );

    const notifyFileChange = debounce(
      (file: TFile) => {
        this.stateManagers.forEach((manager) => {
          if (manager.file !== file) {
            manager.onFileMetadataChange();
          }
        });
      },
      2000,
      true
    );

    this.registerEvent(
      app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          notifyFileChange(file);

          if (this.isHuyBacklogFile(file)) {
            this.syncHuyBacklogKanbanDebounced();
          }
        }
      })
    );

    this.registerEvent(
      app.metadataCache.on('changed', (file) => {
        notifyFileChange(file);

        if (this.isHuyBacklogFile(file)) {
          this.syncHuyBacklogKanbanDebounced();
        }
      })
    );

    this.registerEvent(
      (app as any).metadataCache.on('dataview:metadata-change', (_: any, file: TFile) => {
        notifyFileChange(file);
      })
    );

    this.registerEvent(
      (app as any).metadataCache.on('dataview:api-ready', () => {
        this.stateManagers.forEach((manager) => {
          manager.forceRefresh();
        });
      })
    );

    (app.workspace as any).registerHoverLinkSource(frontmatterKey, {
      display: 'Kanban',
      defaultMod: true,
    });
  }

  registerCommands() {
    this.addCommand({
      id: 'create-new-kanban-board',
      name: t('Create new board'),
      callback: () => this.newKanban(),
    });

    this.addCommand({
      id: 'sync-huy-backlog-kanban',
      name: 'Sync Huy Backlog Kanban from frontmatter',
      callback: () => this.syncHuyBacklogKanban(true),
    });

    this.addCommand({
      id: 'archive-completed-cards',
      name: t('Archive completed cards in active board'),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(KanbanView);

        if (!activeView) return false;
        if (checking) return true;

        this.stateManagers.get(activeView.file).archiveCompletedCards();
      },
    });

    this.addCommand({
      id: 'toggle-kanban-view',
      name: t('Toggle between Kanban and markdown mode'),
      checkCallback: (checking) => {
        const activeFile = app.workspace.getActiveFile();

        if (!activeFile) return false;

        const fileCache = app.metadataCache.getFileCache(activeFile);
        const fileIsKanban = !!fileCache?.frontmatter && !!fileCache.frontmatter[frontmatterKey];

        if (checking) {
          return fileIsKanban;
        }

        const activeView = app.workspace.getActiveViewOfType(KanbanView);

        if (activeView) {
          this.kanbanFileModes[(activeView.leaf as any).id || activeFile.path] = 'markdown';
          this.setMarkdownView(activeView.leaf);
        } else if (fileIsKanban) {
          const activeView = app.workspace.getActiveViewOfType(MarkdownView);

          if (activeView) {
            this.kanbanFileModes[(activeView.leaf as any).id || activeFile.path] = kanbanViewType;
            this.setKanbanView(activeView.leaf);
          }
        }
      },
    });

    this.addCommand({
      id: 'convert-to-kanban',
      name: t('Convert empty note to Kanban'),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(MarkdownView);

        if (!activeView) return false;

        const isFileEmpty = activeView.file.stat.size === 0;

        if (checking) return isFileEmpty;
        if (isFileEmpty) {
          app.vault
            .modify(activeView.file, basicFrontmatter)
            .then(() => {
              this.setKanbanView(activeView.leaf);
            })
            .catch((e) => console.error(e));
        }
      },
    });

    this.addCommand({
      id: 'add-kanban-lane',
      name: t('Add a list'),
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.emitter.emit('showLaneForm', undefined);
        }
      },
    });

    this.addCommand({
      id: 'view-board',
      name: t('View as board'),
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('board');
        }
      },
    });

    this.addCommand({
      id: 'view-table',
      name: t('View as table'),
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('table');
        }
      },
    });

    this.addCommand({
      id: 'view-list',
      name: t('View as list'),
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(KanbanView);

        if (checking) {
          return view && view instanceof KanbanView;
        }

        if (view && view instanceof KanbanView) {
          view.setView('list');
        }
      },
    });

    this.addCommand({
      id: 'open-board-settings',
      name: t('Open board settings'),
      checkCallback: (checking) => {
        const view = app.workspace.getActiveViewOfType(KanbanView);

        if (!view) return false;
        if (checking) return true;

        view.getBoardSettings();
      },
    });
  }

  registerMonkeyPatches() {
    const self = this;

    this.app.workspace.onLayoutReady(() => {
      this.register(
        around((app as any).commands, {
          executeCommand(next) {
            return function (command: any) {
              const view = app.workspace.getActiveViewOfType(KanbanView);

              if (view && command?.id) {
                view.emitter.emit('hotkey', { commandId: command.id });
              }

              return next.call(this, command);
            };
          },
        })
      );
    });

    this.register(
      around(this.app.workspace, {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        setActiveLeaf(next) {
          return function (...args) {
            next.apply(this, args);
            const view = this.getActiveViewOfType(KanbanView);
            if (view?.activeEditor) {
              this.activeEditor = view.activeEditor;
            }
          };
        },
      })
    );

    // Monkey patch WorkspaceLeaf to open Kanbans with KanbanView by default
    this.register(
      around(WorkspaceLeaf.prototype, {
        // Kanbans can be viewed as markdown or kanban, and we keep track of the mode
        // while the file is open. When the file closes, we no longer need to keep track of it.
        detach(next) {
          return function () {
            const state = this.view?.getState();

            if (state?.file && self.kanbanFileModes[this.id || state.file]) {
              delete self.kanbanFileModes[this.id || state.file];
            }

            return next.apply(this);
          };
        },

        setViewState(next) {
          return function (state: ViewState, ...rest: any[]) {
            if (
              // Don't force kanban mode during shutdown
              self._loaded &&
              // If we have a markdown file
              state.type === 'markdown' &&
              state.state?.file &&
              // And the current mode of the file is not set to markdown
              self.kanbanFileModes[this.id || state.state.file] !== 'markdown'
            ) {
              // Then check for the kanban frontMatterKey
              const cache = self.app.metadataCache.getCache(state.state.file);

              if (cache?.frontmatter && cache.frontmatter[frontmatterKey]) {
                // If we have it, force the view type to kanban
                const newState = {
                  ...state,
                  type: kanbanViewType,
                };

                self.kanbanFileModes[state.state.file] = kanbanViewType;

                return next.apply(this, [newState, ...rest]);
              }
            }

            return next.apply(this, [state, ...rest]);
          };
        },
      })
    );
  }
}
