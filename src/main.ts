import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { Notice, Plugin } from "obsidian";
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

    wrapper.appendChild(
      this.createButton(
        view,
        "コピー",
        "copy",
        "この見出しから次の同レベル以上の見出し直前までをコピー",
      ),
    );
    wrapper.appendChild(
      this.createButton(
        view,
        "↓",
        "increase",
        "範囲内の見出しレベルを1つ下げる",
      ),
    );
    wrapper.appendChild(
      this.createButton(
        view,
        "↑",
        "decrease",
        "範囲内の見出しレベルを1つ上げる",
      ),
    );

    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }

  private createButton(
    view: EditorView,
    label: string,
    action: Action,
    title: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;

    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.plugin.executeAction(view, this.headingFrom, action);
    });

    return button;
  }
}

class HeadingToolsViewPlugin {
  decorations: DecorationSet;
  private headings: HeadingInfo[];
  private hoveredHeadingFrom: number | null = null;
  private readonly handleMouseMove: (event: MouseEvent) => void;
  private readonly handleMouseLeave: () => void;

  constructor(
    private readonly view: EditorView,
    private readonly plugin: HeadingSectionToolsPlugin,
  ) {
    this.headings = getHeadings(view);
    this.decorations = this.buildDecorations(view);
    this.handleMouseMove = (event) => this.updateHoveredHeading(event);
    this.handleMouseLeave = () => this.setHoveredHeading(null);
    view.dom.addEventListener("mousemove", this.handleMouseMove);
    view.dom.addEventListener("mouseleave", this.handleMouseLeave);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
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
    this.view.dom.removeEventListener("mousemove", this.handleMouseMove);
    this.view.dom.removeEventListener("mouseleave", this.handleMouseLeave);
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

      if ((!view.hasFocus || !hasFocusedSelection) && !isHovered) {
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
