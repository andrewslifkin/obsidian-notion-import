import { App, PluginSettingTab, Setting, SuggestModal, TextComponent, TFolder, TFile } from 'obsidian';

export interface NotionImporterSettings {
  notionToken: string;
  databaseId: string;
  destinationFolder: string;
  fileNamingPattern: string;
  includeDateInFilename: boolean;
  dateFormat: string;
  datePosition: 'prefix' | 'suffix';
  dateSeparator: string;
  dateSource: 'created' | 'current';
  autoImport: boolean;
  importInterval: number; // minutes
  useTemplate: boolean;
  templatePath: string;
  bidirectionalSync: boolean;
  connections?: { databaseId: string; destinationFolder: string }[];
}

export interface NotionImporterLike {
  app: App;
  settings: NotionImporterSettings;
  saveSettings(): Promise<void>;
  generateFileName(title: string, createdDate?: string): string;
  startAutoImport(): void;
}

export class NotionImporterSettingTab extends PluginSettingTab {
  plugin: NotionImporterLike;
  previewEl: HTMLElement;

  constructor(app: App, plugin: NotionImporterLike) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    // Migrate legacy single mapping into connections list (one-time, non-destructive)
    if (!this.plugin.settings.connections || this.plugin.settings.connections.length === 0) {
      this.plugin.settings.connections = [];
      if (this.plugin.settings.databaseId && this.plugin.settings.destinationFolder) {
        this.plugin.settings.connections.push({
          databaseId: this.plugin.settings.databaseId,
          destinationFolder: this.plugin.settings.destinationFolder,
        });
        await this.plugin.saveSettings();
      }
    }

    containerEl.createEl('h2', { text: 'Notion Importer Settings' });

    // Connection Settings
    containerEl.createEl('h3', { text: 'Connection Settings' });

    new Setting(containerEl)
      .setName('Notion Token')
      .setDesc('Your Notion integration token')
      .addText(text => text
        .setValue(this.plugin.settings.notionToken)
        .onChange(async (value) => {
          this.plugin.settings.notionToken = value;
          await this.plugin.saveSettings();
        }));

    // Multi-database mappings
    containerEl.createEl('h3', { text: 'Connections (Database ↔ Folder)' });

    const connectionsWrapper = containerEl.createDiv({ cls: 'connections-wrapper' });

    const renderConnections = () => {
      connectionsWrapper.empty();

      const conns = this.plugin.settings.connections ?? [];
      if (conns.length === 0) {
        const empty = connectionsWrapper.createDiv({ cls: 'setting-item-description' });
        empty.setText('No connections configured. Add one below.');
      }

      conns.forEach((conn, idx) => {
        const row = new Setting(connectionsWrapper)
          .setName(`Mapping ${idx + 1}`)
          .setDesc('Notion Database ID ↔ Obsidian Folder');

        row.addText((t: TextComponent) => {
          t.setPlaceholder('Notion Database ID')
            .setValue(conn.databaseId)
            .onChange(async (val) => {
              this.plugin.settings.connections![idx].databaseId = val.trim();
              await this.plugin.saveSettings();
            });
        });

        row.addText((t: TextComponent) => {
          t.setPlaceholder('Folder (e.g., Notes/Notion)')
            .setValue(conn.destinationFolder)
            .onChange(async (val) => {
              this.plugin.settings.connections![idx].destinationFolder = val.trim();
              await this.plugin.saveSettings();
            });

          // Folder suggestions
          const folders = this.app.vault.getAllLoadedFiles()
            .filter((f): f is TFolder => f instanceof TFolder)
            .map(f => f.path);
          const focusListener = () => {
            const modal = new FolderSuggestModal(this.app, t, folders);
            modal.open();
          };
          (t.inputEl as any)._folderSuggestListener = focusListener;
          t.inputEl.addEventListener('focus', focusListener);
        });

        row.addExtraButton(btn => {
          btn.setIcon('trash')
            .setTooltip('Remove mapping')
            .onClick(async () => {
              this.plugin.settings.connections!.splice(idx, 1);
              await this.plugin.saveSettings();
              renderConnections();
            });
        });
      });

      const addRow = new Setting(connectionsWrapper)
        .setName('Add connection')
        .setDesc('Create a new mapping from a Notion database to a destination folder');

      addRow.addButton(btn => {
        btn.setButtonText('Add')
          .setCta()
          .onClick(async () => {
            this.plugin.settings.connections = this.plugin.settings.connections ?? [];
            this.plugin.settings.connections.push({ databaseId: '', destinationFolder: '' });
            await this.plugin.saveSettings();
            renderConnections();
          });
      });
    };

    renderConnections();

    // File Settings
    containerEl.createEl('h3', { text: 'File Settings' });

    // Preview
    this.previewEl = containerEl.createEl('div', {
      cls: 'setting-item-description',
      text: 'Preview: '
    });
    this.updatePreview();

    new Setting(containerEl)
      .setName('File Naming Pattern')
      .setDesc('Pattern for naming imported files (use {{title}} for the page title)')
      .addText(text => text
        .setValue(this.plugin.settings.fileNamingPattern)
        .onChange(async (value) => {
          this.plugin.settings.fileNamingPattern = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Include Date in Filename')
      .setDesc('Add date to the filename')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeDateInFilename)
        .onChange(async (value) => {
          this.plugin.settings.includeDateInFilename = value;
          await this.plugin.saveSettings();
          this.updatePreview();
        }));

    new Setting(containerEl)
      .setName('Date Source')
      .setDesc('Choose whether to use the Notion entry date or current date')
      .addDropdown(dropdown => dropdown
        .addOption('created', 'Notion entry date')
        .addOption('current', 'Current date')
        .setValue(this.plugin.settings.dateSource)
        .onChange(async (value: 'created' | 'current') => {
          this.plugin.settings.dateSource = value;
          await this.plugin.saveSettings();
          this.updatePreview();
        }));

    new Setting(containerEl)
      .setName('Date Format')
      .setDesc('Format for the date (e.g., YYYY-MM-DD, YYYYMMDD, DD-MM-YYYY)')
      .addText(text => text
        .setValue(this.plugin.settings.dateFormat)
        .onChange(async (value) => {
          this.plugin.settings.dateFormat = value;
          await this.plugin.saveSettings();
          this.updatePreview();
        }));

    new Setting(containerEl)
      .setName('Date Position')
      .setDesc('Where to place the date in the filename')
      .addDropdown(dropdown => dropdown
        .addOption('prefix', 'Before title')
        .addOption('suffix', 'After title')
        .setValue(this.plugin.settings.datePosition)
        .onChange(async (value: 'prefix' | 'suffix') => {
          this.plugin.settings.datePosition = value;
          await this.plugin.saveSettings();
          this.updatePreview();
        }));

    new Setting(containerEl)
      .setName('Date Separator')
      .setDesc('Character(s) to use between date and title (e.g., --, _, )')
      .addText(text => text
        .setValue(this.plugin.settings.dateSeparator)
        .onChange(async (value) => {
          this.plugin.settings.dateSeparator = value;
          await this.plugin.saveSettings();
          this.updatePreview();
        }));

    // Synchronization Settings
    containerEl.createEl('h3', { text: 'Synchronization Settings' });

    new Setting(containerEl)
      .setName('Bidirectional Sync')
      .setDesc('Enable syncing local changes back to Notion (changes in Obsidian will be reflected in Notion)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.bidirectionalSync)
        .onChange(async (value) => {
          this.plugin.settings.bidirectionalSync = value;
          await this.plugin.saveSettings();
        }));

    // Auto Import Settings
    containerEl.createEl('h3', { text: 'Auto Import Settings' });

    new Setting(containerEl)
      .setName('Auto Import')
      .setDesc('Automatically import on a schedule')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoImport)
        .onChange(async (value) => {
          this.plugin.settings.autoImport = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.startAutoImport();
          }
        }));

    new Setting(containerEl)
      .setName('Import Interval (minutes)')
      .setDesc('How often to check for updates when auto-import is enabled')
      .addText(text => text
        .setValue(String(this.plugin.settings.importInterval))
        .onChange(async (value) => {
          this.plugin.settings.importInterval = Number(value);
          await this.plugin.saveSettings();
        }));

    // Template Settings
    containerEl.createEl('h3', { text: 'Template Settings' });

    new Setting(containerEl)
      .setName('Use Template')
      .setDesc('Use an Obsidian template for imported notes')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.useTemplate)
        .onChange(async (value) => {
          this.plugin.settings.useTemplate = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Template Path')
      .setDesc('Path to the template file (e.g., templates/notion-import.md)')
      .addText((text: TextComponent) => {
        text
          .setPlaceholder('Example: templates/notion-import.md')
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath = value;
            await this.plugin.saveSettings();
          });

        const markdownFiles = this.app.vault.getMarkdownFiles().map(f => f.path);
        const focusListener = () => {
          const modal = new FileSuggestModal(this.app, text, markdownFiles, this.plugin);
          modal.open();
        };
        (text.inputEl as any)._fileSuggestListener = focusListener;
        text.inputEl.addEventListener('focus', focusListener);
      });
  }

  updatePreview() {
    const sampleTitle = 'Sample Note Title';
    const sampleDate = '2024-03-27';
    const fileName = this.plugin.generateFileName(sampleTitle, sampleDate);
    this.previewEl.setText(`Preview: ${fileName}.md`);
  }
}

export class FolderSuggestModal extends SuggestModal<string> {
  constructor(app: App, private textComponent: TextComponent, private folders: string[]) {
    super(app);
  }

  getSuggestions(query: string): string[] {
    const lowercaseQuery = query.toLowerCase();
    return this.folders
      .filter(f => f.toLowerCase().includes(lowercaseQuery))
      .sort((a, b) => a.length - b.length);
  }

  renderSuggestion(value: string, el: HTMLElement) {
    el.setText(value);
  }

  onChooseSuggestion(item: string, evt: MouseEvent | KeyboardEvent) {
    this.textComponent.setValue(item);
    const listener = (this.textComponent.inputEl as any)._folderSuggestListener;
    if (listener) {
      this.textComponent.inputEl.removeEventListener('focus', listener);
      delete (this.textComponent.inputEl as any)._folderSuggestListener;
    }
    this.close();
  }
}

export class FileSuggestModal extends SuggestModal<string> {
  constructor(app: App, private textComponent: TextComponent, private files: string[], private plugin: NotionImporterLike) {
    super(app);
  }

  getSuggestions(query: string): string[] {
    const lowercaseQuery = query.toLowerCase();
    return this.files
      .filter(f => f.toLowerCase().includes(lowercaseQuery))
      .sort((a, b) => a.length - b.length);
  }

  renderSuggestion(value: string, el: HTMLElement) {
    el.setText(value);
  }

  async onChooseSuggestion(item: string, evt: MouseEvent | KeyboardEvent) {
    this.textComponent.setValue(item);
    this.plugin.settings.templatePath = item;
    await this.plugin.saveSettings();

    const listener = (this.textComponent.inputEl as any)._fileSuggestListener;
    if (listener) {
      this.textComponent.inputEl.removeEventListener('focus', listener);
      delete (this.textComponent.inputEl as any)._fileSuggestListener;
    }
    this.close();
  }
}
