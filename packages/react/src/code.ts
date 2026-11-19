/** Same alphabet as the relay (no 0/1/I/L/O/U); duplicated so the UI package needs no protocol import. */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const CODE_LENGTH = 6;

/** Cleans what a user typed or pasted into an invite code: uppercase, no spaces or dashes. */
export function cleanCodeInput(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").slice(0, CODE_LENGTH);
}

/** Returns the canonical code, or null if `input` is not a complete valid code. */
export function parseCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

/** `href` with its hash replaced by the code, e.g. https://x.test/tic-tac-toe/#ABC234 */
export function inviteLink(href: string, code: string): string {
  const url = new URL(href);
  url.hash = code;
  return url.toString();
}
