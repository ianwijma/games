import { type SVGProps, useId } from "react";

const BRASS = "#e0ab45";
const CREAM = "#fffaf0";
const BLACK = "#1c1715";

interface MarkColours {
  /** The five taken seats. */
  seats: string;
  /** The table, and the open seat with its plus. */
  table: string;
  /** The four invite-code dots on the table. */
  code: string;
}

const TAKEN_SEATS = [
  [36, 21],
  [36, 79],
  [64, 79],
  [11, 50],
  [89, 50],
] as const;

/**
 * The site's mark, drawn in a 100 x 100 box: a table with an invite code on it, five seats taken
 * and one open with a plus. Place it with a transform on a parent `<g>`.
 */
function Mark({ seats, table, code }: MarkColours) {
  return (
    <>
      <rect x="22" y="32" width="56" height="36" rx="18" fill={table} />
      {[36.5, 45.5, 54.5, 63.5].map((x) => (
        <circle key={x} cx={x} cy="50" r="3.4" fill={code} />
      ))}
      {TAKEN_SEATS.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="7.5" fill={seats} />
      ))}
      <circle cx="64" cy="21" r="7.5" fill="none" stroke={table} strokeWidth="2.6" />
      <path
        d="M60.4 21 H67.6 M64 17.4 V24.6"
        stroke={table}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </>
  );
}

/** The site icon: the mark on a square of felt with a wooden edge. Size it with CSS. */
export function Logo(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label="Games" {...props}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f8f63" />
          <stop offset="1" stopColor="#175239" />
        </linearGradient>
      </defs>
      <rect
        x="3"
        y="3"
        width="94"
        height="94"
        rx="22"
        fill={`url(#${id})`}
        stroke="#6e4527"
        strokeWidth="6"
      />
      <g transform="translate(50 50) scale(0.66) translate(-50 -50)">
        <Mark seats={CREAM} table={BRASS} code="#154a34" />
      </g>
    </svg>
  );
}

/**
 * The back of every card on the site, in a 5:7 box. Use it for any face-down card unless a game
 * has a specific reason for its own back (see docs/design.md). Size it with CSS width.
 */
export function CardBack(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  const dim = { seats: "#6b5330", table: "#6b5330", code: BLACK };
  const tile = (
    <g transform="scale(0.2)" opacity="0.9">
      <Mark {...dim} />
    </g>
  );
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Face-down card" {...props}>
      <defs>
        <pattern id={`${id}p`} width="23" height="42" patternUnits="userSpaceOnUse">
          <rect width="23" height="42" fill={BLACK} />
          {tile}
          <g transform="translate(11.5 21)">{tile}</g>
          <g transform="translate(-11.5 21)">{tile}</g>
        </pattern>
        <clipPath id={`${id}c`}>
          <rect x="5" y="5" width="90" height="130" rx="7" />
        </clipPath>
      </defs>
      <rect
        x="0.75"
        y="0.75"
        width="98.5"
        height="138.5"
        rx="10"
        fill={CREAM}
        stroke="#d8cba9"
        strokeWidth="1.5"
      />
      <g clipPath={`url(#${id}c)`}>
        <rect width="100" height="140" fill={`url(#${id}p)`} />
        <rect
          x="8"
          y="8"
          width="84"
          height="124"
          rx="5"
          fill="none"
          stroke={BRASS}
          strokeWidth="1.6"
        />
        <circle cx="50" cy="70" r="28" fill={BLACK} stroke={BRASS} strokeWidth="2.2" />
        <g transform="translate(50 70) scale(0.42) translate(-50 -50)">
          <Mark seats={CREAM} table={BRASS} code={BLACK} />
        </g>
      </g>
    </svg>
  );
}
