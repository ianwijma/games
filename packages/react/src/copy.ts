/** The few browser pieces `copyText` needs, so a test can pass fakes. */
export interface CopyEnv {
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } } | undefined;
  document?: Document | undefined;
}

/** The old way: select a hidden field and ask the browser to copy it. Only works inside a tap. */
function copyWithSelection(text: string, doc: Document): boolean {
  const field = doc.createElement("textarea");
  field.value = text;
  // readOnly keeps the phone keyboard closed; off-screen and 16px so iOS neither shows nor zooms.
  field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:-9999px;font-size:16px;opacity:0";
  doc.body.appendChild(field);
  const active = doc.activeElement as HTMLElement | null;
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    active?.focus?.();
  }
}

/**
 * Put `text` on the clipboard and report whether it worked. Call it directly from a click handler.
 * The clipboard API is tried first; some phone browsers lack it or refuse it, so the selection way
 * is the fallback. The fallback also runs when the API rejects, which still works in browsers that
 * keep the tap "active" for a moment.
 */
export async function copyText(text: string, env: CopyEnv = globalThis): Promise<boolean> {
  const clipboard = env.navigator?.clipboard;
  const doc = env.document;
  if (!clipboard?.writeText) return doc ? copyWithSelection(text, doc) : false;
  // Start the API call before anything else so it is inside the tap.
  const viaApi = clipboard.writeText(text).then(
    () => true,
    () => false,
  );
  if (await viaApi) return true;
  return doc ? copyWithSelection(text, doc) : false;
}
