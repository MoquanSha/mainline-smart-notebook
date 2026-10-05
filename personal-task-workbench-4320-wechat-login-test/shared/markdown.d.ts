export type MarkdownNode = { type: 'text'; text: string } | { type: 'node'; name: string; attrs: Record<string, string>; children: MarkdownNode[] };
export function parseMarkdown(value: unknown): MarkdownNode[];
export function markdownLinks(nodes: MarkdownNode[]): { label: string; url: string }[];
export function textContent(nodes: MarkdownNode[]): string;
export function journalBody(entry: { source?: string; organizationSummary?: string; journalSummary?: string; organizedContent?: string; markdown?: string; content?: string; rawContent?: string }): string;
