// Safe Markdown rendering for replies and Markdown panels.
import DOMPurify from "/vendor/dompurify/purify.es.mjs";
import { marked } from "/vendor/marked/marked.esm.js";

marked.use({ gfm: true, breaks: true });

const FORBID_TAGS = ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "video", "audio"];

export function renderMarkdown(text) {
    return DOMPurify.sanitize(marked.parse(text ?? "", { async: false }), { FORBID_TAGS, FORBID_ATTR: ["style"] });
}
