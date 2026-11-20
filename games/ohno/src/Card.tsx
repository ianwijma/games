import type { CSSProperties, ReactNode } from "react";
import { cardLabel } from "./text";
import type { Card, Color } from "./types";

/** One shape per colour, so a colour is never the only signal. */
export type Shape = "diamond" | "triangle" | "square" | "circle";

export const COLOR_SHAPE: Record<Color, Shape> = {
  red: "diamond",
  yellow: "triangle",
  green: "square",
  blue: "circle",
};

/** The four colours as CSS values; the custom properties live in ohno.css. */
export const COLOR_VAR: Record<Color, string> = {
  red: "var(--ohno-red)",
  yellow: "var(--ohno-yellow)",
  green: "var(--ohno-green)",
  blue: "var(--ohno-blue)",
};

const INK = "var(--ink)";
const WHITE = "#fff";

/** A small stand-alone shape, for seats, the active colour and the colour chooser. */
export function ShapeIcon({
  shape,
  fill = WHITE,
  stroke = INK,
  className,
}: {
  shape: Shape;
  fill?: string;
  stroke?: string;
  className?: string;
}) {
  const style: CSSProperties = { fill, stroke };
  const common = { style, strokeWidth: 2.4, strokeLinejoin: "round" as const };
  let body: ReactNode;
  if (shape === "diamond") body = <polygon points="12,2 22,12 12,22 2,12" {...common} />;
  else if (shape === "triangle") body = <polygon points="12,3 22.5,21 1.5,21" {...common} />;
  else if (shape === "square")
    body = <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" {...common} />;
  else body = <circle cx="12" cy="12" r="9.5" {...common} />;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {body}
    </svg>
  );
}

const TEXT_FONT: CSSProperties = { fontFamily: "var(--font-ui)", stroke: INK };

function Figure({
  x,
  y,
  size,
  outline,
  fill = WHITE,
  children,
}: {
  x: number;
  y: number;
  size: number;
  outline: number;
  fill?: string;
  children: ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={size}
      fill={fill}
      strokeWidth={outline}
      paintOrder="stroke"
      strokeLinejoin="round"
      fontWeight={900}
      style={TEXT_FONT}
    >
      {children}
    </text>
  );
}

/** The no-entry sign and the two opposite arrows, drawn at unit size around (0, 0). */
function symbolPaths(kind: "skip" | "reverse"): ReactNode {
  if (kind === "skip") {
    return (
      <>
        <circle r="11" />
        <path d="M-7.8 7.8 L7.8 -7.8" />
      </>
    );
  }
  return (
    <g transform="rotate(-45)">
      <path d="M-11 -5.5 H8" />
      <path d="M3 -11 L9 -5.5 L3 0" />
      <path d="M11 5.5 H-8" />
      <path d="M-3 0 L-9 5.5 L-3 11" />
    </g>
  );
}

function Glyph({
  kind,
  x,
  y,
  scale,
  outline,
}: {
  kind: "skip" | "reverse";
  x: number;
  y: number;
  scale: number;
  outline: number;
}) {
  const paths = symbolPaths(kind);
  const common = {
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g {...common} strokeWidth={outline} style={{ stroke: INK }}>
        {paths}
      </g>
      <g {...common} strokeWidth={4.4} stroke={WHITE}>
        {paths}
      </g>
    </g>
  );
}

const WHEEL: { color: Color; quarter: (cx: number, cy: number, r: number) => string }[] = [
  {
    color: "red",
    quarter: (cx, cy, r) => `M${cx} ${cy} L${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy - r} Z`,
  },
  {
    color: "blue",
    quarter: (cx, cy, r) => `M${cx} ${cy} L${cx + r} ${cy} A${r} ${r} 0 0 0 ${cx} ${cy - r} Z`,
  },
  {
    color: "green",
    quarter: (cx, cy, r) => `M${cx} ${cy} L${cx + r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy + r} Z`,
  },
  {
    color: "yellow",
    quarter: (cx, cy, r) => `M${cx} ${cy} L${cx - r} ${cy} A${r} ${r} 0 0 0 ${cx} ${cy + r} Z`,
  },
];

function Wheel({ cx, cy, r, outline }: { cx: number; cy: number; r: number; outline: number }) {
  return (
    <>
      {WHEEL.map((q) => (
        <path key={q.color} d={q.quarter(cx, cy, r)} style={{ fill: COLOR_VAR[q.color] }} />
      ))}
      <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth={outline} style={{ stroke: INK }} />
    </>
  );
}

/** The small figure in the top-left corner (drawn again, turned, bottom-right). */
function Corner({ card, shapes }: { card: Card; shapes: boolean }) {
  const { value, color } = card;
  let figure: ReactNode;
  if (value === "skip" || value === "reverse") {
    figure = <Glyph kind={value} x={17} y={22} scale={0.6333} outline={15.14} />;
  } else if (value === "wild") {
    figure = <Wheel cx={17} cy={22} r={7.98} outline={3.4} />;
  } else if (value === "wild4" || value === "draw2") {
    figure = (
      <Figure x={17} y={26.5} size={12.92} outline={3.4}>
        {value === "draw2" ? "+2" : "+4"}
      </Figure>
    );
  } else {
    figure = (
      <>
        <Figure x={17} y={28.6} size={19} outline={3.4}>
          {value}
        </Figure>
        {(value === "6" || value === "9") && (
          <path d="M12 31.5 H22" stroke={WHITE} strokeWidth={2} strokeLinecap="round" />
        )}
      </>
    );
  }
  return (
    <>
      {figure}
      {shapes && color !== null && <CornerShape shape={COLOR_SHAPE[color]} />}
    </>
  );
}

function CornerShape({ shape }: { shape: Shape }) {
  const props = {
    fill: WHITE,
    strokeWidth: 1.6,
    strokeLinejoin: "round" as const,
    style: { stroke: INK },
  };
  if (shape === "diamond") return <polygon points="17,34.5 21.6,40 17,45.5 12.4,40" {...props} />;
  if (shape === "triangle") return <polygon points="17,35.4 22.1,44.1 11.9,44.1" {...props} />;
  if (shape === "square")
    return <rect x="12.9" y="35.9" width="8.3" height="8.3" rx="1" {...props} />;
  return <circle cx="17" cy="40" r="4.6" {...props} />;
}

/** The big figure in the middle of the card. */
function Centre({ card }: { card: Card }) {
  const { value } = card;
  if (value === "skip" || value === "reverse")
    return <Glyph kind={value} x={50} y={70} scale={2.2} outline={8.945} />;
  if (value === "wild") return <Wheel cx={50} cy={70} r={25} outline={2} />;
  if (value === "wild4") {
    return (
      <>
        <Wheel cx={50} cy={70} r={25} outline={2} />
        <Figure x={50} y={79.1} size={26} outline={5} fill="#fffaf0">
          +4
        </Figure>
      </>
    );
  }
  if (value === "draw2")
    return (
      <Figure x={50} y={85.7} size={44.88} outline={5}>
        +2
      </Figure>
    );
  return (
    <Figure x={50} y={93.1} size={66} outline={5}>
      {value}
    </Figure>
  );
}

/**
 * One face-up card as a single inline SVG: cream edge, solid colour, one huge white figure with a
 * dark outline, the same figure small in two corners. Sized by `--card-w` (see ohno.css).
 * Face-down cards are `CardBack` from `@games/react`, never drawn here.
 * `decorative` hides it from assistive tech, for cards inside a button that carries the label.
 */
export function OhnoCard({
  card,
  shapes = false,
  decorative = false,
  className = "",
}: {
  card: Card;
  shapes?: boolean;
  decorative?: boolean;
  className?: string;
}) {
  const label = cardLabel(card);
  const fill = card.color === null ? "var(--ohno-wild)" : COLOR_VAR[card.color];
  const corner = <Corner card={card} shapes={shapes} />;
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the title is added unless the card is decorative
    <svg
      className={`ohno-card ${className}`.trim()}
      viewBox="0 0 100 140"
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      focusable="false"
    >
      {!decorative && <title>{label}</title>}
      <rect
        x="0.75"
        y="0.75"
        width="98.5"
        height="138.5"
        rx="10"
        strokeWidth="1.5"
        style={{ fill: "var(--paper)", stroke: "var(--paper-edge)" }}
      />
      <rect x="5" y="5" width="90" height="130" rx="7" style={{ fill }} />
      <Centre card={card} />
      {corner}
      <g transform="rotate(180 50 70)">{corner}</g>
    </svg>
  );
}
