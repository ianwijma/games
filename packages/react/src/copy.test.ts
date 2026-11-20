import { expect, test, vi } from "vitest";
import { type CopyEnv, copyText } from "./copy";

function fakeDocument(result: boolean | "throw") {
  const field = {
    value: "",
    readOnly: false,
    style: { cssText: "" },
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const doc = {
    createElement: vi.fn(() => field),
    body: { appendChild: vi.fn() },
    activeElement: null,
    execCommand: vi.fn(() => {
      if (result === "throw") throw new Error("blocked");
      return result;
    }),
  };
  return { doc: doc as unknown as Document, field, raw: doc };
}

test("uses the clipboard API when it works", async () => {
  const writeText = vi.fn(async () => {});
  const { doc, raw } = fakeDocument(true);
  expect(await copyText("ABC123", { navigator: { clipboard: { writeText } }, document: doc })).toBe(
    true,
  );
  expect(writeText).toHaveBeenCalledWith("ABC123");
  expect(raw.execCommand).not.toHaveBeenCalled();
});

test("falls back to selecting a hidden field when the API refuses", async () => {
  const writeText = vi.fn(async () => {
    throw new Error("NotAllowedError");
  });
  const { doc, field, raw } = fakeDocument(true);
  expect(await copyText("ABC123", { navigator: { clipboard: { writeText } }, document: doc })).toBe(
    true,
  );
  expect(field.value).toBe("ABC123");
  expect(raw.execCommand).toHaveBeenCalledWith("copy");
  expect(field.remove).toHaveBeenCalled();
});

test("falls back when there is no clipboard API at all", async () => {
  const { doc, raw } = fakeDocument(true);
  expect(await copyText("ABC123", { navigator: {}, document: doc })).toBe(true);
  expect(raw.execCommand).toHaveBeenCalled();
});

test("reports failure when nothing works, and still removes the field", async () => {
  for (const result of [false, "throw"] as const) {
    const { doc, field } = fakeDocument(result);
    const env: CopyEnv = { navigator: {}, document: doc };
    expect(await copyText("ABC123", env)).toBe(false);
    expect(field.remove).toHaveBeenCalled();
  }
  expect(await copyText("ABC123", {})).toBe(false);
});
