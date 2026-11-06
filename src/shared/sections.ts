/**
 * Parts of a site you can view on their own (the All / Baseball / Football switch). A visit belongs to the
 * section of the page it started on. Patterns are SQLite GLOBs of at most 50 bytes (D1's limit), and the
 * section with no patterns is everything the others don't claim. In code rather than site settings
 * because only FanRanked uses it.
 */
export interface Section {
  name: string;
  patterns?: string[];
}

const SECTIONS: Record<string, Section[]> = {
  'fanranked.com': [
    { name: 'Baseball' },
    {
      name: 'Football',
      patterns: [
        '/football',
        '/football/*',
        // Football articles live under /blog. One without "football" in its address needs adding here.
        '/blog/*football*',
        '/blog/2026-08-24-ashton-jeanty-*',
      ],
    },
    {
      name: 'Shared',
      patterns: [
        '/',
        '/leagues',
        '/leagues/*',
        '/profile',
        '/profile/*',
        '/u/*',
        '/pro',
        '/supporter',
        '/support',
        '/feed',
        '/analytics',
        '/apps',
        '/platform',
        '/integrations/*',
        '/connections',
        '/connect/*',
        '/discord-activity',
        '/contributors',
        '/contributors/*',
        '/email/*',
        '/privacy',
        '/terms',
        '/admin',
        '/admin/*',
      ],
    },
  ],
};

export const sectionsFor = (domain: string): Section[] => SECTIONS[domain.replace(/^www\./, '').toLowerCase()] ?? [];

/** The entry pages a section takes in (or, for the catch-all, leaves out). Null when the site has no such section. */
export function sectionMatch(domain: string, name: string): { exclude: boolean; patterns: string[] } | null {
  const all = sectionsFor(domain);
  const section = all.find((s) => s.name === name);
  if (!section) return null;
  return section.patterns
    ? { exclude: false, patterns: section.patterns }
    : { exclude: true, patterns: all.flatMap((s) => s.patterns ?? []) };
}
