/**
 * Batch 36 Part 3: Smart paste — turns a customer's message
 *
 *   Rume
 *   Yousuf traders dhan dokaner pisone basha,uttar bazar,poroshuram, Feni
 *   01638820872
 *
 * into the New order fields. Plain rules only (no outside service): phone
 * numbers by pattern, the name by label or position, the thana by matching
 * our own thana list with Banglish spelling tolerance, and the address is
 * the customer's own words with only spaces and commas tidied.
 */

export interface ThanaOption {
  name: string;
  district: string;
  /** Bengali spelling, when our list has it. */
  bnName?: string;
}

export interface DistrictOption {
  name: string;
  bnName?: string;
}

export interface ThanaCandidate extends ThanaOption {
  score: number;
}

export interface ParsedOrderMessage {
  phone: string | null;
  altPhone: string | null;
  name: string | null;
  address: string;
  /** Set only when the match is clear; otherwise null and see `thanaChoices`. */
  thana: ThanaOption | null;
  /** The best three, for one-tap chips. */
  thanaChoices: ThanaOption[];
  /** The customer's own words the thana was matched from ("poroshuram"). */
  thanaMatchedText: string | null;
  district: string | null;
  /** Shown as hints only — never added to the order by themselves. */
  codHint: string | null;
  productHint: string | null;
}

/* ---------------- Digits and phones ---------------- */

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export function toAsciiDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/** A Bangladeshi mobile number anywhere in the text: optional +88 / 88 /
 *  0088, then 01[3-9] and eight more digits, with spaces, dashes or dots
 *  allowed between digits. */
const PHONE_PATTERN = /(?:(?:\+|00)?\s*8\s*8[\s.\-–]*)?0\s*1\s*[3-9](?:[\s.\-–]*\d){8}(?!\d)/g;

export function normalizeBdPhone(raw: string): string | null {
  const digits = toAsciiDigits(raw).replace(/\D/g, '').replace(/^(00)?88(?=01)/, '');
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

function findPhones(text: string): { phones: string[]; rest: string } {
  const phones: string[] = [];
  const rest = text.replace(PHONE_PATTERN, (m) => {
    const phone = normalizeBdPhone(m);
    if (phone && !phones.includes(phone)) phones.push(phone);
    return phone ? ' ' : m;
  });
  return { phones, rest };
}

/* ---------------- Labels ---------------- */

type LabelKind = 'name' | 'phone' | 'address' | 'cod' | 'product' | 'thana' | 'district';

const LABELS: { kind: LabelKind; words: string[] }[] = [
  { kind: 'name', words: ['name', 'naam', 'nam', 'customer name', 'customer', 'নাম'] },
  { kind: 'phone', words: ['phone', 'mobile', 'mob', 'number', 'num', 'contact', 'cell', 'phone number', 'mobile number', 'ফোন', 'মোবাইল', 'নম্বর', 'নাম্বার'] },
  { kind: 'address', words: ['address', 'add', 'addr', 'thikana', 'location', 'ঠিকানা'] },
  { kind: 'cod', words: ['cod', 'price', 'amount', 'total', 'taka', 'tk', 'bill', 'দাম', 'টাকা'] },
  { kind: 'product', words: ['product', 'products', 'item', 'items', 'order', 'pcs', 'পণ্য', 'প্রোডাক্ট'] },
  { kind: 'thana', words: ['thana', 'ps', 'p.s', 'upazila', 'upojela', 'area', 'police station', 'থানা', 'উপজেলা'] },
  { kind: 'district', words: ['district', 'zilla', 'zila', 'jela', 'jilla', 'জেলা'] },
];

function readLabel(line: string): { kind: LabelKind; value: string } | null {
  // \p{M}: Bengali vowel signs ("নাম") are marks, not letters.
  const m = /^\s*([\p{L}.][\p{L}\p{M}. ]{0,20}?)\s*[:：=\-–]\s*(.*)$/u.exec(line);
  if (!m) return null;
  const word = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
  for (const label of LABELS) {
    if (label.words.includes(word)) return { kind: label.kind, value: m[2].trim() };
  }
  return null;
}

/* ---------------- Banglish spelling ---------------- */

const DROP_WORDS = new Set(['sadar', 'shadar', 'sador', 'thana', 'upazila', 'upozila', 'model', 'ps', 'pourashava', 'municipality', 'city', 'zila', 'zilla', 'district', 'সদর', 'থানা', 'উপজেলা', 'মডেল']);

/** "Poroshuram" and "Parshuram" both become "parsuram"-like keys. */
export function banglishKey(text: string): string {
  let s = text.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  s = s
    .replace(/gonj|gong/g, 'ganj')
    .replace(/sh|ss/g, 's')
    .replace(/ph/g, 'f')
    .replace(/kh/g, 'k')
    .replace(/oo|ou/g, 'u')
    .replace(/ee|ii/g, 'i')
    .replace(/[yw]/g, (c) => (c === 'y' ? 'i' : 'o'))
    .replace(/z/g, 'j')
    .replace(/q/g, 'k')
    .replace(/v/g, 'b')
    .replace(/o/g, 'a')
    .replace(/(.)\1+/g, '$1');
  return s;
}

/** Consonants only — the sturdiest key of all ("prsrm"). */
function skeletonKey(text: string): string {
  return banglishKey(text).replace(/[aeiuh]/g, '');
}

function placeWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-–_/(),.]+/)
    .filter((w) => w !== '' && !DROP_WORDS.has(w));
}

/** Jaro–Winkler similarity, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j += 1) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k += 1;
    if (a[i] !== b[k]) t += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** How alike a piece of the message is to a place name (0..1). */
function placeSimilarity(piece: string, place: string): number {
  const a = banglishKey(piece);
  const b = banglishKey(place);
  if (a.length < 3 || b.length < 3) return a === b && a.length > 0 ? 1 : 0;
  if (a === b) return 1;
  let score = jaroWinkler(a, b);
  const sa = skeletonKey(piece);
  const sb = skeletonKey(place);
  // Same consonants: enough for a chip, never enough to choose by itself.
  if (sa.length >= 3 && sa === sb) score = Math.max(score, 0.9);
  // Very different lengths are rarely the same place.
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (ratio < 0.6) score *= 0.8;
  return score;
}

/* ---------------- Pieces of the message ---------------- */

interface Piece {
  /** As written in the message. */
  text: string;
  words: number;
}

/** Every run of 1–3 words inside each comma-separated part. */
function piecesOf(text: string): Piece[] {
  const out: Piece[] = [];
  for (const part of text.split(/[,\n;|।]+/)) {
    const words = part
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, ''))
      .filter((w) => w !== '');
    for (let size = 1; size <= 3; size += 1) {
      for (let i = 0; i + size <= words.length; i += 1) {
        const slice = words.slice(i, i + size);
        if (slice.some((w) => /\d/.test(w))) continue;
        out.push({ text: slice.join(' '), words: size });
      }
    }
  }
  return out;
}

function hasBengali(text: string): boolean {
  return /[ঀ-৿]/.test(text);
}

/* ---------------- Districts and thanas ---------------- */

const DISTRICT_ALIASES: Record<string, string> = {
  chittagong: 'Chattogram',
  ctg: 'Chattogram',
  chattagram: 'Chattogram',
  comilla: 'Cumilla',
  cumilla: 'Cumilla',
  bogra: 'Bogura',
  barisal: 'Barishal',
  jessore: 'Jashore',
  laxmipur: 'Lakshmipur',
};

function findDistrict(text: string, districts: readonly DistrictOption[]): { name: string; words: string } | null {
  let best: { name: string; words: string; score: number } | null = null;
  const names = new Map(districts.map((d) => [d.name.toLowerCase(), d.name]));
  for (const piece of piecesOf(text)) {
    if (piece.words > 2) continue;
    const alias = DISTRICT_ALIASES[piece.text.toLowerCase()];
    const aliasName = alias ? names.get(alias.toLowerCase()) : undefined;
    if (aliasName) {
      if (!best || best.score < 1) best = { name: aliasName, words: piece.text, score: 1 };
      continue;
    }
    for (const d of districts) {
      // Stricter than thanas: a district is only taken when clearly
      // written ("Mirpur" must not become Meherpur).
      const a = banglishKey(piece.text);
      const b = banglishKey(d.name);
      const latin = a.length >= 3 ? jaroWinkler(a, b) : 0;
      const score = Math.max(latin >= 0.95 ? latin : 0, d.bnName && piece.text === d.bnName ? 1 : 0);
      // Later in the message wins a tie: the district is usually last.
      if (score >= 0.93 && (!best || score >= best.score)) best = { name: d.name, words: piece.text, score };
    }
  }
  return best ? { name: best.name, words: best.words } : null;
}

interface ScoredThana {
  entry: ThanaOption;
  score: number;
  matched: string | null;
  /** Matched only because its name is the district's ("Feni Sadar"). */
  viaDistrictName: boolean;
}

function scoreThanas(
  text: string,
  thanas: readonly ThanaOption[],
  district: string | null,
  districtWords: string | null
): ScoredThana[] {
  const pieces = piecesOf(text);
  const bengali = hasBengali(text);
  const districtKey = districtWords ? banglishKey(districtWords) : null;
  const scored: ScoredThana[] = [];
  for (const entry of thanas) {
    const words = placeWords(entry.name);
    if (words.length === 0) continue;
    const full = words.join(' ');
    let best = 0;
    let matched: string | null = null;
    let viaDistrictName = false;
    for (const piece of pieces) {
      // The same number of words, or the first word of a longer name
      // ("Uttara" for "Uttara East") at a slightly lower score.
      let s = 0;
      if (piece.words === words.length) s = placeSimilarity(piece.text, full);
      else if (piece.words === 1 && words.length > 1) s = placeSimilarity(piece.text, words[0]) * 0.92;
      if (s > best) {
        best = s;
        matched = piece.text;
      }
    }
    const bnCore = entry.bnName ? entry.bnName.replace(/\s*(সদর|মডেল)$/u, '') : '';
    if (bengali && bnCore !== '' && text.includes(bnCore)) {
      best = 1;
      matched = bnCore;
    }
    if (best < 0.84) continue;
    // "Feni" in the message is the district; "Feni Sadar" only a guess.
    const sameAsDistrict =
      matched !== null &&
      districtWords !== null &&
      (matched === districtWords || (districtKey !== null && districtKey !== '' && banglishKey(matched) === districtKey));
    if (sameAsDistrict) {
      viaDistrictName = true;
      best = Math.min(best, 0.86);
    }
    if (district) best += entry.district === district ? 0.04 : -0.12;
    scored.push({ entry, score: best, matched, viaDistrictName });
  }
  return scored.sort((a, b) => b.score - a.score);
}

const CONFIDENT = 0.92;
const CLEAR_LEAD = 0.035;
const ALONE = 0.9;
const ALONE_LEAD = 0.08;

/* ---------------- Name and address ---------------- */

const ADDRESS_WORDS = [
  'road', 'rd', 'house', 'holding', 'bari', 'barir', 'basa', 'basha', 'bashar', 'bazar', 'bazaar', 'para', 'village', 'vill', 'gram', 'gramer',
  'post', 'po', 'near', 'pase', 'pashe', 'pisone', 'pichone', 'pechone', 'samne', 'shamne', 'mor', 'more', 'sorok', 'lane', 'block', 'sector',
  'flat', 'floor', 'tola', 'union', 'market', 'school', 'college', 'madrasa', 'mosque', 'masjid', 'office', 'traders', 'store', 'shop', 'dokan',
  'dokaner', 'hospital', 'station', 'stand', 'colony', 'avenue', 'street', 'goli', 'ward', 'no', 'east', 'west', 'north', 'south', 'uttar',
  'dokkhin', 'purbo', 'poschim', 'বাসা', 'বাড়ি', 'রোড', 'বাজার', 'গ্রাম', 'পাড়া', 'থানা', 'জেলা',
];

function looksLikeAddress(line: string, thanas: readonly ThanaOption[], districts: readonly DistrictOption[]): boolean {
  if (/[,/#]/.test(line)) return true;
  const words = line.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 4) return true;
  if (words.some((w) => ADDRESS_WORDS.includes(w.replace(/[^\p{L}\p{M}]/gu, '')))) return true;
  const whole = line.trim();
  if (districts.some((d) => placeSimilarity(whole, d.name) >= 0.95 || d.bnName === whole)) return true;
  if (thanas.some((t) => placeSimilarity(whole, placeWords(t.name).join(' ')) >= 0.95 || t.bnName === whole)) return true;
  return false;
}

/** Spaces and commas tidied; the words themselves are never changed. */
export function tidyAddress(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(,\s*){2,}/g, ', ')
    .replace(/\s*\n\s*/g, ', ')
    .replace(/(,\s*){2,}/g, ', ')
    .replace(/^[\s,.;:\-–]+|[\s,;:\-–]+$/g, '')
    .trim();
}

/* ---------------- The parser ---------------- */

export function parseOrderMessage(
  message: string,
  thanas: readonly ThanaOption[],
  districts: readonly DistrictOption[]
): ParsedOrderMessage {
  const text = toAsciiDigits(message.replace(/\r\n?/g, '\n'));
  let name: string | null = null;
  let codHint: string | null = null;
  let productHint: string | null = null;
  let thanaLabel: string | null = null;
  const addressParts: string[] = [];
  const freeLines: string[] = [];

  const { phones, rest } = findPhones(text);

  for (const rawLine of rest.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const label = readLabel(line);
    if (label) {
      if (label.kind === 'name') name = label.value || name;
      else if (label.kind === 'cod') codHint = label.value || codHint;
      else if (label.kind === 'product') productHint = label.value || productHint;
      else if (label.kind === 'address') addressParts.push(label.value);
      else if (label.kind === 'thana') {
        thanaLabel = label.value;
        addressParts.push(label.value);
      } else if (label.kind === 'district') addressParts.push(label.value);
      continue;
    }
    // A line that was only a phone number is now empty punctuation.
    if (!/[\p{L}]/u.test(line)) continue;
    freeLines.push(line);
  }

  if (name === null) {
    const index = freeLines.findIndex((l) => !/\d/.test(l) && !looksLikeAddress(l, thanas, districts));
    if (index >= 0) {
      name = freeLines[index];
      freeLines.splice(index, 1);
    }
  }
  const address = tidyAddress([...addressParts, ...freeLines].join('\n'));

  const where = [thanaLabel ?? '', address].join(', ');
  const district = findDistrict(where, districts);
  const scored = scoreThanas(thanaLabel ?? where, thanas, district?.name ?? null, district?.words ?? null);
  // A thana label that matched nothing: try the whole address too.
  const ranked = scored.length > 0 || !thanaLabel ? scored : scoreThanas(where, thanas, district?.name ?? null, district?.words ?? null);

  // A real thana beats the district's own "Sadar" guess.
  const real = ranked.filter((r) => !r.viaDistrictName);
  const ordered = [...real, ...ranked.filter((r) => r.viaDistrictName)];
  const unique: ScoredThana[] = [];
  for (const r of ordered) {
    if (!unique.some((u) => u.entry.name === r.entry.name && u.entry.district === r.entry.district)) unique.push(r);
  }
  const top = unique[0] ?? null;
  const second = unique[1] ?? null;
  const rivalGap = second === null || second.viaDistrictName ? 1 : top ? top.score - second.score : 0;
  const confident =
    top !== null &&
    !top.viaDistrictName &&
    // A strong match clearly ahead, or a near-strong one with no rival.
    ((top.score >= CONFIDENT && rivalGap >= CLEAR_LEAD) || (top.score >= ALONE && rivalGap >= ALONE_LEAD));

  // Chips: the best matches, then (when a district is known) its other
  // thanas, so there are always three to tap.
  const choices: ThanaOption[] = unique.slice(0, 3).map((r) => r.entry);
  if (choices.length < 3 && district) {
    const sameDistrict = thanas
      .filter((t) => t.district === district.name && !choices.some((c) => c.name === t.name && c.district === t.district))
      .sort((a, b) => a.name.localeCompare(b.name));
    // The district's own Sadar thana first among the fillers.
    sameDistrict.sort((a, b) => Number(/sadar/i.test(b.name)) - Number(/sadar/i.test(a.name)));
    choices.push(...sameDistrict.slice(0, 3 - choices.length));
  }

  return {
    phone: phones[0] ?? null,
    altPhone: phones[1] ?? null,
    name: name ? name.trim() : null,
    address,
    thana: confident && top ? top.entry : null,
    thanaChoices: choices,
    thanaMatchedText: top?.matched ?? null,
    district: confident && top ? top.entry.district : (district?.name ?? null),
    codHint,
    productHint,
  };
}
