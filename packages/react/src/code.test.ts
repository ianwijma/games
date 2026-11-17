import { describe, expect, it } from "vitest";
import { cleanCodeInput, inviteLink, parseCode } from "./code";

describe("invite codes", () => {
  it("cleans input", () => {
    expect(cleanCodeInput(" abc-234 ")).toBe("ABC234");
    expect(cleanCodeInput("abcdefghjk")).toBe("ABCDEF");
  });
  it("parses only complete valid codes", () => {
    expect(parseCode("abc-234")).toBe("ABC234");
    expect(parseCode("ABC23")).toBeNull();
    expect(parseCode("ABC230")).toBeNull();
  });
  it("builds a link with the code in the hash", () => {
    expect(inviteLink("https://x.test/tic-tac-toe/?a=1#OLD", "ABC234")).toBe(
      "https://x.test/tic-tac-toe/?a=1#ABC234",
    );
  });
});
