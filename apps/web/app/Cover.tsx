import type { CSSProperties, ReactNode } from "react";
import type { Slug } from "../src/catalog";

/**
 * The picture on each game's box. Drawn here, not imported from the game, so the overview page
 * loads no game code (see catalog.ts). Every slug needs its own entry: the type checker enforces it.
 */

const INK = "#2b211a";

function MiniCard({
  x,
  y,
  turn,
  fill,
  children,
}: {
  x: number;
  y: number;
  turn: number;
  fill: string;
  children: ReactNode;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${turn})`}>
      <rect x="-25" y="-35" width="50" height="70" rx="5.5" fill="#000" opacity="0.28" />
      <rect
        x="-25"
        y="-37"
        width="50"
        height="70"
        rx="5.5"
        fill="#f7f0e1"
        stroke="#d8cba9"
        strokeWidth="1"
      />
      <rect x="-22" y="-34" width="44" height="64" rx="3.5" fill={fill} />
      <g transform="translate(0 -2)">{children}</g>
    </g>
  );
}

function Figure({ children }: { children: string }) {
  return (
    <text
      y="12"
      textAnchor="middle"
      fontSize="34"
      fontWeight={900}
      fill="#fff"
      stroke={INK}
      strokeWidth="3.2"
      strokeLinejoin="round"
      paintOrder="stroke"
      style={{ fontFamily: "var(--font-ui)" }}
    >
      {children}
    </text>
  );
}

function OhnoCover() {
  const sign = (
    <>
      <circle r="11" />
      <path d="M-7.8 7.8 L7.8 -7.8" />
    </>
  );
  return (
    <svg className="cover-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
      <MiniCard x={45} y={66} turn={-16} fill="#2b7fd4">
        <Figure>7</Figure>
      </MiniCard>
      <MiniCard x={80} y={58} turn={0} fill="#2e9d57">
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <g stroke={INK} strokeWidth="8.6">
            {sign}
          </g>
          <g stroke="#fff" strokeWidth="4.4">
            {sign}
          </g>
        </g>
      </MiniCard>
      <MiniCard x={115} y={66} turn={16} fill="#f3c22b">
        <Figure>+2</Figure>
      </MiniCard>
    </svg>
  );
}

function TicTacToeCover() {
  return (
    <div className="grid3">
      <b className="x">X</b>
      <b className="o">O</b>
      <b className="x">X</b>
      <b />
      <b className="x">X</b>
      <b className="o">O</b>
      <b />
      <b />
      <b className="o">O</b>
    </div>
  );
}

const COVERS: Record<Slug, { color: string; art: () => ReactNode }> = {
  ohno: { color: "#c44a32", art: OhnoCover },
  "tic-tac-toe": { color: "#3f8fd9", art: TicTacToeCover },
};

export function Cover({ slug }: { slug: Slug }) {
  const { color, art: Art } = COVERS[slug];
  return (
    <div className="cover" style={{ "--c": color } as CSSProperties} aria-hidden="true">
      <Art />
    </div>
  );
}
