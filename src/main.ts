import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { App, MarkdownView, Menu, Notice, Plugin, SuggestModal } from "obsidian";
import styles from "./styles.css";

type HeadingInfo = {
  lineNumber: number;
  from: number;
  to: number;
  level: number;
};

type SectionRange = {
  from: number;
  to: number;
};

type Action = "copy" | "decrease" | "increase";

function isFenceLine(
  text: string,
): { marker: "`" | "~"; length: number } | null {
  const match = text.match(/^\s{0,3}(`{3,}|~{3,})/);
  if (!match) {
    return null;
  }

  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

function getHeadings(view: EditorView): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber++) {
    const line = view.state.doc.line(lineNumber);
    const text = line.text;
    const fenceLine = isFenceLine(text);

    if (fenceLine) {
      if (!fence) {
        fence = fenceLine;
      } else if (
        fence.marker === fenceLine.marker &&
        fenceLine.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    if (fence) {
      continue;
    }

    const match = text.match(/^(#{1,6})[ \t]+/);
    if (!match) {
      continue;
    }

    headings.push({
      lineNumber,
      from: line.from,
      to: line.to,
      level: match[1].length,
    });
  }

  return headings;
}

function getSectionRange(view: EditorView, heading: HeadingInfo): SectionRange {
  const headings = getHeadings(view);
  const nextSectionHeading = headings.find(
    (candidate) =>
      candidate.lineNumber > heading.lineNumber &&
      candidate.level <= heading.level,
  );

  return {
    from: heading.from,
    to: nextSectionHeading ? nextSectionHeading.from : view.state.doc.length,
  };
}

function transformHeadingLevels(text: string, delta: -1 | 1): string | null {
  const lines = text.split("\n");
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const fenceLine = isFenceLine(lines[i]);

    if (fenceLine) {
      if (!fence) {
        fence = fenceLine;
      } else if (
        fence.marker === fenceLine.marker &&
        fenceLine.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    if (fence) {
      continue;
    }

    const match = lines[i].match(/^(#{1,6})([ \t]+.*)$/);
    if (!match) {
      continue;
    }

    const currentLevel = match[1].length;
    const nextLevel = currentLevel + delta;

    if (nextLevel < 1 || nextLevel > 6) {
      return null;
    }

    lines[i] = "#".repeat(nextLevel) + match[2];
    changed = true;
  }

  return changed ? lines.join("\n") : text;
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

type TocEntry = HeadingInfo & { title: string };

class HeadingTocModal extends SuggestModal<TocEntry> {
  private readonly sourceDoc;
  private readonly headings: TocEntry[];

  constructor(app: App, private readonly view: EditorView) {
    super(app);
    this.sourceDoc = view.state.doc;
    this.headings = getHeadings(view).map((heading) => ({
      ...heading,
      title: this.sourceDoc
        .line(heading.lineNumber)
        .text.replace(/^#{1,6}[ \t]+/, "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .trim(),
    }));
    this.limit = Math.max(1, this.headings.length);
    this.shouldRestoreSelection = false;
    this.setTitle("目次（TOC）");
    this.setPlaceholder("見出しを検索…");
    this.emptyStateText = "該当する見出しがありません。";
    this.setInstructions([
      { command: "↑ ↓", purpose: "見出しを選択" },
      { command: "Enter", purpose: "選択した見出しへ移動" },
      { command: "Esc", purpose: "閉じる" },
    ]);
  }

  getSuggestions(query: string): TocEntry[] {
    const search = query.trim().toLocaleLowerCase();
    return this.headings.filter((heading) =>
      heading.title.toLocaleLowerCase().includes(search),
    );
  }

  renderSuggestion(heading: TocEntry, el: HTMLElement): void {
    el.classList.add("heading-section-toc-entry");
    el.style.setProperty("--heading-level", String(heading.level - 1));
    el.createSpan({
      cls: "heading-section-toc-title",
      text: heading.title || "（無題の見出し）",
    });
    el.createSpan({
      cls: "heading-section-toc-location",
      text: `H${heading.level} · ${heading.lineNumber}行`,
    });
  }

  onChooseSuggestion(heading: TocEntry): void {
    if (!this.view.dom.isConnected) {
      return;
    }
    if (this.view.state.doc !== this.sourceDoc) {
      new Notice("本文が変更されたため、TOCを開き直してください。");
      return;
    }
    this.view.dispatch({
      selection: { anchor: heading.from },
      effects: EditorView.scrollIntoView(heading.from, { y: "center" }),
    });
    this.view.focus();
  }
}

class HeadingToolsWidget extends WidgetType {
  constructor(
    private readonly plugin: HeadingSectionToolsPlugin,
    private readonly headingFrom: number,
  ) {
    super();
  }

  eq(other: HeadingToolsWidget): boolean {
    return other.headingFrom === this.headingFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "heading-section-tools";
    wrapper.dataset.headingFrom = String(this.headingFrom);
    wrapper.setAttribute("role", "toolbar");
    wrapper.setAttribute("aria-label", "見出し操作");
    wrapper.addEventListener("keydown", (event) => {
      // Let native button activation and Tab work without editor key bindings.
      event.stopPropagation();
      const buttons = Array.from(wrapper.querySelectorAll("button"));
      const index = buttons.indexOf(
        wrapper.ownerDocument.activeElement as HTMLButtonElement,
      );
      let nextIndex: number;
      switch (event.key) {
        case "ArrowRight":
          nextIndex = (index + 1) % buttons.length;
          break;
        case "ArrowLeft":
          nextIndex = (index + buttons.length - 1) % buttons.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = buttons.length - 1;
          break;
        case "Escape":
          event.preventDefault();
          view.focus();
          return;
        default:
          return;
      }
      event.preventDefault();
      buttons[nextIndex]?.focus();
    });

    wrapper.appendChild(
      this.createButton(
        "コピー",
        "この見出しから次の同レベル以上の見出し直前までをコピー",
        () => void this.plugin.executeAction(view, this.headingFrom, "copy"),
      ),
    );
    const levelButton = this.createButton(
      "レベル変更",
      "見出しレベルを変更するメニューを開く",
      () => {
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle("見出しレベルを1つ下げる")
            .setIcon("arrow-down")
            .onClick(() => {
              void this.plugin.executeAction(view, this.headingFrom, "increase");
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("見出しレベルを1つ上げる")
            .setIcon("arrow-up")
            .onClick(() => {
              void this.plugin.executeAction(view, this.headingFrom, "decrease");
            }),
        );
        const bounds = levelButton.getBoundingClientRect();
        // Keep menu actions away from the click that opens the menu.
        menu.showAtPosition(
          { x: bounds.left, y: bounds.bottom + 8 },
          levelButton.ownerDocument,
        );
      },
    );
    levelButton.setAttribute("aria-haspopup", "menu");
    wrapper.appendChild(levelButton);
    const tocButton = this.createButton(
      "TOC",
      "このノートの見出し一覧を開く",
      () => new HeadingTocModal(this.plugin.app, view).open(),
    );
    tocButton.setAttribute("aria-haspopup", "dialog");
    wrapper.appendChild(tocButton);

    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }

  private createButton(
    label: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);

    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });

    return button;
  }
}

class HeadingToolsViewPlugin {
  decorations: DecorationSet;
  private headings: HeadingInfo[];
  private hoveredHeadingFrom: number | null = null;
  private toolbarHeadingFrom: number | null = null;
  private readonly handleMouseMove: (event: MouseEvent) => void;
  private readonly handleMouseLeave: () => void;
  private readonly handleFocusOut: () => void;
  private focusFrame: number | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly plugin: HeadingSectionToolsPlugin,
  ) {
    this.headings = getHeadings(view);
    this.decorations = this.buildDecorations(view);
    this.handleMouseMove = (event) => this.updateHoveredHeading(event);
    this.handleMouseLeave = () => this.setHoveredHeading(null);
    this.handleFocusOut = () => {
      // Wait until focus has moved to distinguish Tab within the toolbar.
      queueMicrotask(() => {
        if (
          this.toolbarHeadingFrom !== null &&
          !this.view.dom.querySelector(
            `.heading-section-tools[data-heading-from="${this.toolbarHeadingFrom}"]`,
          )?.contains(this.view.dom.ownerDocument.activeElement)
        ) {
          this.toolbarHeadingFrom = null;
          this.decorations = this.buildDecorations(this.view);
          this.view.dispatch({});
        }
      });
    };
    view.dom.addEventListener("mousemove", this.handleMouseMove);
    view.dom.addEventListener("mouseleave", this.handleMouseLeave);
    view.dom.addEventListener("focusout", this.handleFocusOut);
  }

  focusToolbar(): void {
    const cursor = this.view.state.selection.main.head;
    const currentHeading = this.headings.find(
      (heading) => cursor >= heading.from && cursor <= heading.to,
    );
    const visibleToolbar = this.view.dom.querySelector<HTMLElement>(
      currentHeading
        ? `.heading-section-tools[data-heading-from="${currentHeading.from}"]`
        : ".heading-section-tools",
    ) ?? this.view.dom.querySelector<HTMLElement>(".heading-section-tools");
    const heading = visibleToolbar
      ? this.headings.find(
          (item) => item.from === Number(visibleToolbar.dataset.headingFrom),
        )
      : this.headings.filter((item) => item.from <= cursor).pop();
    if (!heading) {
      new Notice("カーソル位置より前に見出しがありません。");
      return;
    }

    this.toolbarHeadingFrom = heading.from;
    this.decorations = this.buildDecorations(this.view);
    this.view.dispatch({
      ...(visibleToolbar ? {} : { selection: { anchor: heading.from } }),
      effects: EditorView.scrollIntoView(heading.to, { y: "nearest" }),
    });
    const win = this.view.dom.ownerDocument.defaultView ?? window;
    if (this.focusFrame !== null) {
      win.cancelAnimationFrame(this.focusFrame);
    }
    // Scrolling can create a widget outside the previous viewport.
    this.focusFrame = win.requestAnimationFrame(() => {
      this.focusFrame = null;
      this.view.dom.querySelector<HTMLButtonElement>(
        `.heading-section-tools[data-heading-from="${heading.from}"] button`,
      )?.focus();
    });
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.toolbarHeadingFrom = null;
      this.headings = getHeadings(update.view);
    }

    if (
      update.docChanged ||
      update.selectionSet ||
      update.focusChanged ||
      update.viewportChanged ||
      update.geometryChanged
    ) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  destroy(): void {
    this.toolbarHeadingFrom = null;
    if (this.focusFrame !== null) {
      (this.view.dom.ownerDocument.defaultView ?? window).cancelAnimationFrame(this.focusFrame);
    }
    this.view.dom.removeEventListener("mousemove", this.handleMouseMove);
    this.view.dom.removeEventListener("mouseleave", this.handleMouseLeave);
    this.view.dom.removeEventListener("focusout", this.handleFocusOut);
  }

  private updateHoveredHeading(event: MouseEvent): void {
    let hoveredHeadingFrom: number | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const heading of this.headings) {
      const coordinates = this.view.coordsAtPos(heading.from);

      if (coordinates === null) {
        continue;
      }

      const distance =
        event.clientY < coordinates.top
          ? coordinates.top - event.clientY
          : event.clientY > coordinates.bottom
            ? event.clientY - coordinates.bottom
            : 0;

      if (distance <= 20 && distance < nearestDistance) {
        hoveredHeadingFrom = heading.from;
        nearestDistance = distance;
      }
    }

    this.setHoveredHeading(hoveredHeadingFrom);
  }

  private setHoveredHeading(headingFrom: number | null): void {
    if (this.hoveredHeadingFrom === headingFrom) {
      return;
    }

    this.hoveredHeadingFrom = headingFrom;
    this.decorations = this.buildDecorations(this.view);
    this.view.dispatch({});
  }

  private buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();

    for (const heading of this.headings) {
      const hasFocusedSelection = view.state.selection.ranges.some(
        (range) => range.head >= heading.from && range.head <= heading.to,
      );
      const isHovered = heading.from === this.hoveredHeadingFrom;

      const hasToolbarFocus = heading.from === this.toolbarHeadingFrom;
      if (
        (!view.hasFocus || !hasFocusedSelection) &&
        !isHovered &&
        !hasToolbarFocus
      ) {
        continue;
      }

      builder.add(
        heading.to,
        heading.to,
        Decoration.widget({
          widget: new HeadingToolsWidget(this.plugin, heading.from),
          side: 1,
        }),
      );
    }

    return builder.finish();
  }
}

export default class HeadingSectionToolsPlugin extends Plugin {
  async onload(): Promise<void> {
    const styleElement = document.createElement("style");
    styleElement.textContent = styles;
    document.head.appendChild(styleElement);
    this.register(() => styleElement.remove());

    const extension = ViewPlugin.define(
      (view) => new HeadingToolsViewPlugin(view, this),
      {
        decorations: (value) => value.decorations,
      },
    );

    this.registerEditorExtension(extension);
    this.addCommand({
      id: "focus-heading-toolbar",
      name: "見出し操作バーにフォーカス",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "h" }],
      checkCallback: (checking) => {
        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!markdownView || markdownView.getMode() !== "source") {
          return false;
        }
        const editorDom = markdownView.containerEl.querySelector<HTMLElement>(
          ".cm-editor",
        );
        const editorView = editorDom ? EditorView.findFromDOM(editorDom) : null;
        const tools = editorView?.plugin(extension);
        if (!tools) {
          return false;
        }
        if (!checking) {
          tools.focusToolbar();
        }
        return true;
      },
    });
  }

  async executeAction(
    view: EditorView,
    headingFrom: number,
    action: Action,
  ): Promise<void> {
    const heading = getHeadings(view).find((item) => item.from === headingFrom);

    if (!heading) {
      new Notice("見出しを特定できませんでした。");
      return;
    }

    const range = getSectionRange(view, heading);
    const source = view.state.doc.sliceString(range.from, range.to);

    if (action === "copy") {
      try {
        await copyText(source);
        new Notice("見出しの範囲をコピーしました。");
      } catch {
        new Notice("クリップボードへのコピーに失敗しました。");
      }
      return;
    }

    const delta: -1 | 1 = action === "increase" ? 1 : -1;
    const changed = transformHeadingLevels(source, delta);

    if (changed === null) {
      new Notice(
        delta === 1
          ? "範囲内にレベル6の見出しがあるため、これ以上下げられません。"
          : "範囲内にレベル1の見出しがあるため、これ以上上げられません。",
      );
      return;
    }

    view.dispatch({
      changes: {
        from: range.from,
        to: range.to,
        insert: changed,
      },
    });

    new Notice(
      delta === 1
        ? "見出しレベルを1つ下げました。"
        : "見出しレベルを1つ上げました。",
    );
  }
}
