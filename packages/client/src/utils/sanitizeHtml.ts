import DOMPurify, { type Config } from 'dompurify'

/**
 * Attributes the renderer adds itself (mermaid placeholders, file cards,
 * highlight.js code-copy buttons). They must survive sanitization or
 * downstream features break.
 */
const RENDERER_DATA_ATTRS = [
  'data-mermaid-pending',
  'data-mermaid-source',
  'data-path',
  'data-filename',
  'data-copy-code',
  'data-copy-source',
]

function buildConfig(): Config {
  return {
    ADD_ATTR: [...RENDERER_DATA_ATTRS],
    // Keep highlight.js spans, mermaid SVG, video/file-card markup intact.
    ADD_TAGS: ['video', 'source'],
    // Reject anything that would let an attacker pivot to script execution
    // (these are DOMPurify defaults but we make them explicit for review).
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onmouseover', 'onmouseout', 'onfocus', 'onblur', 'onclick'],
    ALLOW_DATA_ATTR: false,
  }
}

export function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, buildConfig()) as unknown as string
}
