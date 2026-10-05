/* Whether a Home section had anything to show on the last visit (Batch 29
   Part 7). While the shop's data loads, a section that had content last
   time holds its place with a same-size placeholder, so nothing below it
   jumps down when the data arrives; a section that was empty last time
   reserves nothing (so it can't jump up either). */

const PREFIX = 'nph_home_had_';

export function hadContentLastTime(section: string): boolean {
  try {
    return localStorage.getItem(PREFIX + section) !== '0';
  } catch {
    return true;
  }
}

export function rememberHadContent(section: string, had: boolean): void {
  try {
    localStorage.setItem(PREFIX + section, had ? '1' : '0');
  } catch {
    // Private mode: the next fresh load just reserves the default.
  }
}
