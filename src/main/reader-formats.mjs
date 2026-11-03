import { execFile } from "node:child_process";

const PDF_TEXT = `
function run(argv) {
    ObjC.import("Foundation");
    ObjC.import("AppKit");
    ObjC.import("PDFKit");
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var pdf = $.PDFDocument.alloc.initWithData(data);
    var count = Number(pdf.pageCount);
    var wanted = Number(argv[0]) || 0;
    if (wanted > count) return JSON.stringify({ error: "The PDF has only " + count + " pages" });
    var pages = [];
    var length = 0;
    for (var i = wanted ? wanted - 1 : 0; i < (wanted || Math.min(count, 200)); i++) {
        var text = ObjC.unwrap(pdf.pageAtIndex(i).string) || "";
        length += text.length;
        if (length > 1000000) break;
        pages.push("[Page " + (i + 1) + "]\\n" + text);
    }
    var image = null;
    if (wanted) {
        var thumbnail = pdf.pageAtIndex(wanted - 1).thumbnailOfSizeForBox($.NSMakeSize(1400, 1800), 0);
        var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
        var properties = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithDouble(0.9), $.NSImageCompressionFactor);
        var jpeg = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, properties);
        image = { data: ObjC.unwrap(jpeg.base64EncodedStringWithOptions(0)), mimeType: "image/jpeg" };
    }
    return JSON.stringify({
        title: ObjC.unwrap(pdf.documentAttributes.objectForKey($.PDFDocumentTitleAttribute)) || "",
        text: pages.join("\\n\\n"),
        pageCount: count,
        extractedPages: pages.length,
        pageNumber: wanted || null,
        image: image
    });
}
`;

// PDFKit reads bytes from stdin, without downloading a file or executing embedded PDF scripts.
export function extractPdf(bytes, { page: wanted = 0 } = {}) {
    if (process.platform !== "darwin") return Promise.reject(new Error("PDF text reading needs macOS PDFKit"));
    if (!Number.isInteger(wanted) || wanted < 0) return Promise.reject(new Error("A PDF page must be a positive whole number"));
    return new Promise((resolve, reject) => {
        const child = execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", PDF_TEXT, String(wanted)], { timeout: 8_000, maxBuffer: 8_000_000 }, (error, stdout) => {
            if (error) return reject(new Error("The PDF could not be opened for text reading"));
            try {
                const page = JSON.parse(stdout);
                if (page.error) throw new Error(page.error);
                if (!page.pageCount || (!page.image && !page.text.replace(/\[Page \d+\]/g, "").trim())) throw new Error("The PDF has no extractable text; it may be scanned or encrypted; request #page=N to inspect a page image");
                if (!page.pageNumber && page.extractedPages < page.pageCount) page.text += `\n[Stopped after ${page.extractedPages} of ${page.pageCount} PDF pages]`;
                resolve(page);
            } catch (error) {
                reject(error);
            }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(bytes);
    });
}

export function parseCaptions(source) {
    const cues = [];
    for (const block of String(source).replace(/\r/g, "").split(/\n\s*\n/)) {
        const lines = block.split("\n");
        if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
        const index = lines.findIndex((line) => /^(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->/.test(line));
        if (index < 0) continue;
        const stamp = lines[index].split(/\s+/)[0].replace(/[.,]\d+$/, "");
        const text = lines
            .slice(index + 1)
            .join(" ")
            .replace(/<[^>]*>/g, "")
            .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity])
            .replace(/\s+/g, " ")
            .trim();
        if (text && text !== cues.at(-1)?.text) cues.push({ stamp: stamp.length === 5 ? `00:${stamp}` : stamp, text });
    }
    return cues.map(({ stamp, text }) => `[${stamp}] ${text}`).join("\n");
}
