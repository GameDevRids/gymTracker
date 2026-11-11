// Canvas helpers shared by the welcome card, the payment QR image and the receipt card:
// theme colours and fonts, text that wraps or shrinks to fit, a check that the fonts draw ₹,
// and sharing an image through the phone share sheet (download on desktop).
// No DOM access on load, so the server tests can import modules that use it.

export const CARD_COLORS = { slate: "#1E2D3A", slate2: "#2A3F4F", marigold: "#F4A51C", white: "#FFFFFF", soft: "#C9D2D9", brick: "#B83A26", leaf: "#1D7A4F" };
export const HEADING_FAMILIES = '"Anek Latin", "Anek Devanagari"';
export const BODY_FAMILIES = '"Mukta"';
// System fonts that carry the rupee sign, used for that character only when the web font lacks it.
export const RUPEE_FALLBACK = '"Nirmala UI", "Noto Sans", "Noto Sans Devanagari", Roboto, "Segoe UI", "Helvetica Neue", Arial';

export function setFont(context, weight, size, family) {
    context.font = `${weight} ${size}px ${family}`;
}

/**
 * True when the font list itself draws the character. Measured against two different generic
 * fallbacks: if the width follows the fallback, the character came from the fallback.
 */
export function fontHasGlyph(context, families, character, weight = 700) {
    const width = (family) => { setFont(context, weight, 80, family); return context.measureText(character).width; };
    const viaMono = width(`${families}, monospace`);
    const viaSerif = width(`${families}, serif`);
    return !(viaMono === width("monospace") && viaSerif === width("serif"));
}

/** Font lists for the card, with a system fallback added where a web font has no ₹ glyph. */
export function cardFontFamilies(context) {
    const withRupee = (families) => fontHasGlyph(context, families, "₹") ? `${families}, sans-serif` : `${families}, ${RUPEE_FALLBACK}, sans-serif`;
    return { heading: withRupee(HEADING_FAMILIES), body: withRupee(BODY_FAMILIES), headingHasRupee: fontHasGlyph(context, HEADING_FAMILIES, "₹"), bodyHasRupee: fontHasGlyph(context, BODY_FAMILIES, "₹") };
}

export function truncateToWidth(context, text, width) {
    if (context.measureText(text).width <= width) return text;
    let fitted = text;
    while (fitted.length > 1 && context.measureText(`${fitted}…`).width > width) fitted = fitted.slice(0, -1);
    return `${fitted.trimEnd()}…`;
}

export function wrapWords(context, text, width) {
    const lines = [];
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
        const candidate = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
        if (lines.length && context.measureText(candidate).width <= width) lines[lines.length - 1] = candidate;
        else lines.push(word);
    }
    return lines.length ? lines : [""];
}

/**
 * Fits text into a box: the largest size from max down to min at which it fits on up to
 * maxLines lines within width and maxHeight. Only if nothing fits at the minimum size is the
 * last line shortened with "…".
 */
export function fitTextBlock(context, text, { weight, family, max, min, width, maxLines = 1, maxHeight = Infinity, lineHeight = 1.15 }) {
    for (let size = max; size >= min; size -= 2) {
        setFont(context, weight, size, family);
        const lines = wrapWords(context, text, width);
        if (lines.length <= maxLines && lines.every((line) => context.measureText(line).width <= width) && lines.length * size * lineHeight <= maxHeight) {
            return { lines, size, lineHeight: Math.round(size * lineHeight) };
        }
    }
    const size = Math.max(min, Math.min(max, Math.floor(maxHeight / (maxLines * lineHeight))));
    setFont(context, weight, size, family);
    const words = wrapWords(context, text, width);
    const lines = words.slice(0, maxLines);
    if (words.length > maxLines) lines[maxLines - 1] = `${lines[maxLines - 1]} ${words.slice(maxLines).join(" ")}`;
    return { lines: lines.map((line) => truncateToWidth(context, line, width)), size, lineHeight: Math.round(size * lineHeight) };
}

export function roundedRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
}

export async function cardFontsReady(sample) {
    if (!document.fonts) return;
    const faces = ['700 52px "Anek Latin"', '800 104px "Anek Latin"', '700 44px "Anek Latin"', '700 52px "Anek Devanagari"', '800 104px "Anek Devanagari"', '700 44px "Anek Devanagari"', '500 44px "Mukta"', '400 34px "Mukta"'];
    // Fonts load per character range (the ₹ sign sits in its own range), so ask for the exact text.
    await Promise.all(faces.map((face) => document.fonts.load(face, sample).catch(() => [])));
    await document.fonts.ready;
}

export function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Shares the card through the phone's share sheet where files can be shared (Android Chrome),
 * otherwise downloads it. Resolves to "shared", "cancelled" or "downloaded".
 * Call it straight from the click with a ready file so the share keeps the user's tap.
 */
export async function shareImageFile(file, { text = "" } = {}) {
    if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], ...(text ? { text } : {}) });
            return "shared";
        } catch (error) {
            if (error?.name === "AbortError") return "cancelled";
            // NotAllowedError and similar: fall back to saving the file.
        }
    }
    downloadFile(file);
    return "downloaded";
}
