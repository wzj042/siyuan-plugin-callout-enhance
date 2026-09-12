/**
 * Marker quote conversion: detect blockquotes whose first line carries an
 * existing `[!type]` / `[!type]-` / `[!type]+` text marker (e.g. imported
 * from Obsidian/flomo) and convert them into real SiYuan callout blocks.
 *
 * SiYuan natively parses `> [!type]` only when the marker occupies its own
 * line and at least one content line follows. Single-line markers such as
 * `> [!tip] 单行内容` stay literal blockquotes, and the Obsidian fold
 * suffix (`-` / `+`) is not understood at all (`-` becomes title text).
 * This module closes that gap:
 *
 * 1. Detection: first content paragraph of a `.bq` block starts with
 *    `[!label]` followed by an optional `+`/`-` sign and optional title text.
 * 2. Conversion: `/api/block/updateBlock` (dataType "dom") replaces the
 *    blockquote with a NodeCallout — the marker line becomes the callout
 *    title, remaining lines keep their block ids and inline formatting.
 * 3. Fold symbol: `[!type]-` additionally sets the `fold="1"` block attr so
 *    the callout renders folded; `[!type]+` stays expanded.
 */
import { isPublishService, isWorkspaceReadOnly, requestClApi } from "../core/cl_api";
import { debugLog, errorLog } from "../utils/logger";

/** First line marker: `[!label]` + optional fold sign + optional rest-of-line. */
const MARKER_PATTERN = /^\s*\[!([A-Za-z][A-Za-z0-9_-]*)\]\s*([+-]?)([\s\S]*)$/;

/** ZWSP used by SiYuan to keep empty protyle-attr placeholders. */
const ZWSP = "\u200B";

function isEditableContextActiveWithin(element: HTMLElement) {
    const selection = window.getSelection();
    if (selection?.anchorNode && element.contains(selection.anchorNode)) return true;
    const active = document.activeElement;
    if (active && element.contains(active)) return true;
    return false;
}

function isInsideEmbedBlock(element: HTMLElement) {
    return !!element.closest(".protyle-embed");
}

/** Collect the logical first line of a paragraph-like element. */
function getFirstLineInfo(paragraphEl: HTMLElement) {
    const contentEl = paragraphEl.querySelector('[contenteditable="true"]') as HTMLElement | null
        || paragraphEl;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const text = node.textContent || "";
        const trimmed = text.trim();
        if (!trimmed) continue; // skip pure-whitespace text nodes
        const match = trimmed.match(MARKER_PATTERN);
        if (!match) return null; // first meaningful text is not a marker
        // Title = rest of the marker line: text after the match inside the same
        // text node, plus any trailing inline siblings up to the first <br>.
        let title = (match[3] || "").trim();
        let sibling: Node | null = (node as Text).nextSibling;
        while (sibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE) {
                const el = sibling as HTMLElement;
                if (el.tagName === "BR" || el.dataset?.nodeId) break;
            }
            title += (sibling.textContent || "");
            sibling = sibling.nextSibling;
        }
        return {
            label: match[1],
            sign: match[2] || "",
            title: title.trim(),
            markerTextNode: node as Text,
            contentEl,
        };
    }
    return null;
}

/** Build the remainder of the first paragraph (nodes after the first <br>) as a body paragraph clone. */
function buildRemainderParagraph(paragraphEl: HTMLElement, contentEl: HTMLElement) {
    const br = Array.from(contentEl.querySelectorAll("br")).find((item) => {
        // Only <br> that belong to this paragraph content (not nested blocks).
        let parent = item.parentElement;
        while (parent && parent !== contentEl) {
            if (parent.dataset?.nodeId) return false;
            parent = parent.parentElement;
        }
        return parent === contentEl;
    });
    if (!br) return null;
    const remainderNodes: Node[] = [];
    let node: Node | null = br.nextSibling;
    while (node) {
        remainderNodes.push(node);
        node = node.nextSibling;
    }
    const hasMeaningful = remainderNodes.some((item) => (item.textContent || "").replace(/[\u200B\u00A0]/g, "").trim().length > 0);
    if (!hasMeaningful) return null;
    const clone = paragraphEl.cloneNode(false) as HTMLElement;
    clone.innerHTML = "";
    const newContent = document.createElement("div");
    newContent.setAttribute("contenteditable", "true");
    newContent.setAttribute("spellcheck", "false");
    remainderNodes.forEach((item) => newContent.appendChild(item.cloneNode(true)));
    clone.appendChild(newContent);
    const attr = document.createElement("div");
    attr.className = "protyle-attr";
    attr.setAttribute("contenteditable", "false");
    attr.textContent = ZWSP;
    clone.appendChild(attr);
    return clone;
}

function buildCalloutElement(blockquoteEl: HTMLElement, info: ReturnType<typeof getFirstLineInfo>, bodyChildren: HTMLElement[]) {
    const callout = blockquoteEl.cloneNode(false) as HTMLElement;
    callout.classList.remove("bq");
    callout.classList.add("callout");
    callout.setAttribute("data-type", "NodeCallout");
    callout.setAttribute("data-subtype", info.label.toLowerCase());
    callout.setAttribute("contenteditable", "false");
    delete callout.dataset.nodeIndex;

    const infoDiv = document.createElement("div");
    infoDiv.className = "callout-info";
    infoDiv.setAttribute("contenteditable", "false");
    const iconSpan = document.createElement("span");
    iconSpan.className = "callout-icon";
    const titleSpan = document.createElement("span");
    titleSpan.className = "callout-title";
    titleSpan.setAttribute("contenteditable", "true");
    titleSpan.setAttribute("spellcheck", "false");
    titleSpan.textContent = info.title || info.label;
    infoDiv.appendChild(iconSpan);
    infoDiv.appendChild(titleSpan);

    const contentDiv = document.createElement("div");
    contentDiv.className = "callout-content";
    bodyChildren.forEach((child) => contentDiv.appendChild(child));

    const attrDiv = document.createElement("div");
    attrDiv.className = "protyle-attr";
    attrDiv.setAttribute("contenteditable", "false");
    attrDiv.textContent = ZWSP;

    callout.innerHTML = "";
    callout.appendChild(infoDiv);
    callout.appendChild(contentDiv);
    callout.appendChild(attrDiv);
    return callout;
}

async function convertMarkerQuote(blockquoteEl: HTMLElement, info: ReturnType<typeof getFirstLineInfo>) {
    const blockId = blockquoteEl.dataset.nodeId;
    if (!blockId || !info) return;
    const contentChildren = Array.from(blockquoteEl.children).filter(
        (child) => !(child as HTMLElement).classList?.contains("protyle-attr"),
    ) as HTMLElement[];
    if (!contentChildren.length) return;
    const firstParagraph = contentChildren[0];
    const bodyChildren: HTMLElement[] = [];
    const remainder = buildRemainderParagraph(firstParagraph, info.contentEl);
    if (remainder) bodyChildren.push(remainder);
    contentChildren.slice(1).forEach((child) => bodyChildren.push(child.cloneNode(true) as HTMLElement));

    const callout = buildCalloutElement(blockquoteEl, info, bodyChildren);
    try {
        await requestClApi("/api/block/updateBlock", {
            id: blockId,
            dataType: "dom",
            data: callout.outerHTML,
        });
        debugLog("[marker-convert] converted quote → callout", { blockId, label: info.label, sign: info.sign });
        if (info.sign === "-") {
            await requestClApi("/api/attr/setBlockAttrs", {
                id: blockId,
                attrs: { fold: "1" },
            });
        }
    } catch (err) {
        errorLog("[marker-convert] convert failed:", err);
    }
}

/**
 * Scan a subtree (or the whole document) for blockquotes carrying an
 * existing `[!type]` text marker and convert them into callout blocks.
 */
export function scanMarkerQuotes(root: ParentNode) {
    if (isPublishService() || isWorkspaceReadOnly()) return;
    const scope = (root as HTMLElement)?.classList?.contains("bq") ? [root as HTMLElement] : [];
    const candidates = [
        ...scope,
        ...Array.from(root.querySelectorAll?.('.bq[data-type="NodeBlockquote"]') || []),
    ] as HTMLElement[];
    for (const bq of candidates) {
        if (!bq.isConnected || bq.dataset.calloutEnhanceConverting) continue;
        if (isInsideEmbedBlock(bq)) continue;
        if (isEditableContextActiveWithin(bq)) continue;
        const contentChildren = Array.from(bq.children).filter(
            (child) => !(child as HTMLElement).classList?.contains("protyle-attr"),
        ) as HTMLElement[];
        if (!contentChildren.length) continue;
        const firstParagraph = contentChildren[0];
        if (firstParagraph.dataset?.type !== "NodeParagraph") continue;
        const info = getFirstLineInfo(firstParagraph);
        if (!info) continue;
        // Nothing to convert: marker alone on a single-line quote with no body.
        if (!info.title && contentChildren.length === 1 && !info.contentEl.querySelector("br")) continue;
        bq.dataset.calloutEnhanceConverting = "true";
        const doneConverting = () => {
            delete bq.dataset.calloutEnhanceConverting;
        };
        convertMarkerQuote(bq, info).then(doneConverting, doneConverting);
    }
}
