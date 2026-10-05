export type MarkdownNode = {
  type: 'text' | 'node';
  text?: string;
  name?: string;
  attrs?: Record<string, string>;
  children?: MarkdownNode[];
};
export function parseMarkdown(value: unknown): MarkdownNode[];
export function markdownLinks(nodes: MarkdownNode[]): { label: string; url: string }[];
export function textContent(nodes: MarkdownNode[]): string;
export function journalBody(entry: Record<string, unknown>): string;
