import { createElement, useMemo, type CSSProperties, type ReactNode } from 'react';
import { parseMarkdown, type MarkdownNode } from '../shared/markdown-web.js';

function renderNode(node: MarkdownNode, key: number): ReactNode {
  if (node.type === 'text') return node.text;
  const { style, class: className, ...attrs } = node.attrs;
  const css = Object.fromEntries((style || '').split(';').filter(Boolean).map((declaration) => {
    const colon = declaration.indexOf(':');
    return [declaration.slice(0, colon).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), declaration.slice(colon + 1)];
  })) as CSSProperties;
  const props = { ...attrs, key, className, style: css, ...(node.name === 'a' ? { target: '_blank', rel: 'noopener noreferrer' } : {}) };
  return ['br', 'hr'].includes(node.name) ? createElement(node.name, props)
    : createElement(node.name, props, node.children.map(renderNode));
}
export function MarkdownContent({ content }: { content: string }) {
  const nodes = useMemo(() => parseMarkdown(content), [content]);
  return <div className="todo-markdown">{nodes.map(renderNode)}</div>;
}
