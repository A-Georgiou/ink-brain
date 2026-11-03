// What the Mac accessibility tree would list on a captured page, so evals can snap marks the way the app does.
import { snapPoint, snapShape } from "../src/shared/geometry.mjs";

// Runs in the page: controls, text runs and pictures as { role, name, x, y, w, h } in viewport pixels.
export const PAGE_ELEMENTS = () => {
    const ARIA = { button: "AXButton", link: "AXLink", checkbox: "AXCheckBox", radio: "AXRadioButton", tab: "AXTab", menuitem: "AXMenuItem", menuitemcheckbox: "AXMenuItem", menuitemradio: "AXMenuItem", combobox: "AXComboBox", textbox: "AXTextField", searchbox: "AXTextField", slider: "AXSlider", switch: "AXSwitch", img: "AXImage" };
    const INPUT = { checkbox: "AXCheckBox", radio: "AXRadioButton", range: "AXSlider", button: "AXButton", submit: "AXButton", reset: "AXButton", image: "AXButton", hidden: null };
    const GROUP = "nav, header, footer, main, aside, section, form, ul, ol, table, fieldset, [role=toolbar], [role=group], [role=list], [role=menu], [role=dialog], [role=tablist]";
    const roleOf = (e) => {
        if (ARIA[e.getAttribute("role")]) return ARIA[e.getAttribute("role")];
        switch (e.localName) {
            case "a":
                return e.hasAttribute("href") ? "AXLink" : null;
            case "button":
            case "summary":
                return "AXButton";
            case "select":
                return "AXPopUpButton";
            case "textarea":
                return "AXTextArea";
            case "input":
                return e.type in INPUT ? INPUT[e.type] : "AXTextField";
            case "img":
            case "svg":
            case "canvas":
            case "video":
                return "AXImage";
            default:
                return e.matches(GROUP) ? "AXGroup" : null;
        }
    };
    const out = [];
    const add = (role, name, r) => {
        const x = Math.max(0, r.left);
        const y = Math.max(0, r.top);
        const [w, h] = [Math.min(innerWidth, r.right) - x, Math.min(innerHeight, r.bottom) - y];
        if (w >= 2 && h >= 2) out.push({ role, name: String(name).slice(0, 200).replace(/\s+/g, " ").trim().slice(0, 40), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    };
    const shown = (e) => e.checkVisibility({ visibilityProperty: true });
    for (const e of document.body.querySelectorAll("*")) {
        const role = roleOf(e);
        if (role && shown(e)) add(role, e.getAttribute("aria-label") || e.title || e.textContent, e.getBoundingClientRect());
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
        const parent = n.parentElement;
        if (!n.textContent.trim() || !parent || parent.closest("script, style, noscript") || !shown(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        add("AXStaticText", n.textContent, range.getBoundingClientRect());
    }
    out.push({ role: "AXWebArea", name: document.title, x: 0, y: 0, w: innerWidth, h: innerHeight });
    return out;
};

// The elements covering a point, innermost first, like the helper's chain of an element and its ancestors.
export const elementsAt = (elements, [x, y]) => elements.filter((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h).sort((a, b) => a.w * a.h - b.w * b.h);

// Moves shapes onto the controls under them, as the app does with the real accessibility tree.
export const snapOnto = (elements, shapes) =>
    shapes.map((shape) => {
        const point = snapPoint(shape);
        return point ? snapShape(shape, elementsAt(elements, point)) : shape;
    });
