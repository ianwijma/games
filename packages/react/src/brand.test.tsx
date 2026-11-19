import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CardBack, Logo } from "./brand";

test("two card backs on one page do not share pattern ids", () => {
  const html = renderToStaticMarkup(
    <>
      <CardBack />
      <CardBack />
    </>,
  );
  const ids = [...html.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(html).toContain(`url(#${id})`);
});

test("the logo and the card back are labelled and take a class", () => {
  expect(renderToStaticMarkup(<Logo className="w-8" />)).toMatch(
    /aria-label="Games"[^>]*class="w-8"|class="w-8"[^>]*aria-label="Games"/,
  );
  expect(renderToStaticMarkup(<CardBack />)).toContain('aria-label="Face-down card"');
});
