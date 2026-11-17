import type { ReactNode } from 'react';

/**
 * Batch 45 Part 11: the lot form's Country list. Each country has a small
 * flag drawn as inline SVG (no emoji, nothing downloaded). Simple shapes —
 * recognisable at 20 × 14 px, not exact.
 */
export interface CountryChoice {
  name: string;
  /** Other spellings already saved on lots. */
  aliases: readonly string[];
  flag: ReactNode;
}

const W = 30;
const H = 20;

function Flag({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg className="inv-flag" viewBox={`0 0 ${W} ${H}`} width={21} height={14} role="img" aria-label={`${label} flag`}>
      {children}
      <rect x="0.25" y="0.25" width={W - 0.5} height={H - 0.5} fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="0.5" />
    </svg>
  );
}

const unionJack = (
  <>
    <rect width={W} height={H} fill="#012169" />
    <path d={`M0 0L${W} ${H}M${W} 0L0 ${H}`} stroke="#fff" strokeWidth="4" />
    <path d={`M0 0L${W} ${H}M${W} 0L0 ${H}`} stroke="#C8102E" strokeWidth="1.5" />
    <path d={`M${W / 2} 0V${H}M0 ${H / 2}H${W}`} stroke="#fff" strokeWidth="6" />
    <path d={`M${W / 2} 0V${H}M0 ${H / 2}H${W}`} stroke="#C8102E" strokeWidth="3.4" />
  </>
);

export const COUNTRIES: readonly CountryChoice[] = [
  {
    name: 'Australia',
    aliases: ['au', 'aus', 'australia'],
    flag: (
      <Flag label="Australia">
        <rect width={W} height={H} fill="#012169" />
        <svg x="0" y="0" width={W / 2} height={H / 2} viewBox={`0 0 ${W} ${H}`}>
          {unionJack}
        </svg>
        <circle cx="7.5" cy="15.5" r="1.8" fill="#fff" />
        <circle cx="22" cy="5" r="1" fill="#fff" />
        <circle cx="19" cy="10" r="1" fill="#fff" />
        <circle cx="25" cy="9" r="1" fill="#fff" />
        <circle cx="22" cy="16" r="1.1" fill="#fff" />
      </Flag>
    ),
  },
  {
    name: 'Japan',
    aliases: ['jp', 'japan'],
    flag: (
      <Flag label="Japan">
        <rect width={W} height={H} fill="#fff" />
        <circle cx={W / 2} cy={H / 2} r="6" fill="#BC002D" />
      </Flag>
    ),
  },
  {
    name: 'South Korea',
    aliases: ['kr', 'korea', 'south korea', 'republic of korea'],
    flag: (
      <Flag label="South Korea">
        <rect width={W} height={H} fill="#fff" />
        <path d="M9 10a6 6 0 0 1 12 0z" fill="#C60C30" />
        <path d="M9 10a6 6 0 0 0 12 0z" fill="#003478" />
        <path d="M4 4l3 2M4 16l3-2M26 4l-3 2M26 16l-3-2" stroke="#000" strokeWidth="1.3" />
      </Flag>
    ),
  },
  {
    name: 'Canada',
    aliases: ['ca', 'canada'],
    flag: (
      <Flag label="Canada">
        <rect width={W} height={H} fill="#fff" />
        <rect width="7.5" height={H} fill="#D52B1E" />
        <rect x="22.5" width="7.5" height={H} fill="#D52B1E" />
        <path d="M15 4l1.2 2.6 2-0.8-0.7 3.4 2.2-1.4 0.3 1.4 1.6-0.2-1 2.4 0.8 0.5-3.8 2.6 0.3 1.3H15.4v2.2h-0.8v-2.2h-2.5l0.3-1.3-3.8-2.6 0.8-0.5-1-2.4 1.6 0.2 0.3-1.4 2.2 1.4-0.7-3.4 2 0.8z" fill="#D52B1E" />
      </Flag>
    ),
  },
  {
    name: 'India',
    aliases: ['in', 'india'],
    flag: (
      <Flag label="India">
        <rect width={W} height={H / 3} fill="#FF9933" />
        <rect y={H / 3} width={W} height={H / 3} fill="#fff" />
        <rect y={(2 * H) / 3} width={W} height={H / 3} fill="#138808" />
        <circle cx={W / 2} cy={H / 2} r="2.6" fill="none" stroke="#000080" strokeWidth="0.8" />
      </Flag>
    ),
  },
  {
    name: 'Bangladesh',
    aliases: ['bd', 'bangladesh'],
    flag: (
      <Flag label="Bangladesh">
        <rect width={W} height={H} fill="#006A4E" />
        <circle cx="13.5" cy={H / 2} r="6" fill="#F42A41" />
      </Flag>
    ),
  },
  {
    name: 'United States',
    aliases: ['us', 'usa', 'united states', 'united states of america', 'america'],
    flag: (
      <Flag label="United States">
        <rect width={W} height={H} fill="#fff" />
        {[0, 2, 4, 6, 8, 10, 12].map((i) => (
          <rect key={i} y={(i * H) / 13} width={W} height={H / 13} fill="#B22234" />
        ))}
        <rect width="13" height={(7 * H) / 13} fill="#3C3B6E" />
        {[2.5, 6.5, 10.5].map((x) => [2.5, 6.5, 9.5].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="0.7" fill="#fff" />))}
      </Flag>
    ),
  },
  {
    name: 'United Kingdom',
    aliases: ['uk', 'gb', 'great britain', 'united kingdom', 'england', 'britain'],
    flag: <Flag label="United Kingdom">{unionJack}</Flag>,
  },
  {
    name: 'France',
    aliases: ['fr', 'france'],
    flag: (
      <Flag label="France">
        <rect width={W / 3} height={H} fill="#002395" />
        <rect x={W / 3} width={W / 3} height={H} fill="#fff" />
        <rect x={(2 * W) / 3} width={W / 3} height={H} fill="#ED2939" />
      </Flag>
    ),
  },
];

export const OTHER_COUNTRY = 'Other';

/** The list entry for a saved country text (any case / short code), or null
 *  when it is not in the list (it then shows as typed). */
export function matchCountry(text: string): CountryChoice | null {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  return COUNTRIES.find((c) => c.name.toLowerCase() === key || c.aliases.includes(key)) ?? null;
}

/** A saved country with its flag (or just the text when not in the list). */
export function CountryLabel({ text }: { text: string }) {
  const match = matchCountry(text);
  if (!match) return <>{text}</>;
  return (
    <span className="inv-country">
      {match.flag}
      {match.name}
    </span>
  );
}
