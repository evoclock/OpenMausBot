export interface CatalogCard {
  slug: string;
  categories?: string[];
}

export const INLINE_CATEGORY_COUNT = 5;
export const CATEGORY_SECTION_COUNT = 3;
export const CATEGORY_SECTION_SIZE = 4;

export function rankCategories(cards: readonly CatalogCard[], inline = INLINE_CATEGORY_COUNT): { inline: string[]; more: string[] } {
  const counts = new Map<string, number>();
  for (const card of cards) for (const category of new Set(card.categories ?? [])) counts.set(category, (counts.get(category) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  return { inline: ranked.slice(0, inline), more: ranked.slice(inline) };
}

export function inCategory(card: CatalogCard, category: string | null): boolean {
  return category === null || (card.categories ?? []).includes(category);
}

export type CatalogSection<Card> =
  | { kind: "connected"; cards: Card[] }
  | { kind: "category"; category: string; cards: Card[]; more: boolean }
  | { kind: "all"; cards: Card[] };

export function catalogSections<Card extends CatalogCard>(
  cards: readonly Card[],
  isConnected: (slug: string) => boolean,
  categories: readonly string[],
): CatalogSection<Card>[] {
  const sections: CatalogSection<Card>[] = [];
  const connected = cards.filter((card) => isConnected(card.slug));
  if (connected.length) sections.push({ kind: "connected", cards: connected });
  for (const category of categories.slice(0, CATEGORY_SECTION_COUNT)) {
    const open = cards.filter((card) => !isConnected(card.slug) && inCategory(card, category));
    if (open.length) sections.push({ kind: "category", category, cards: open.slice(0, CATEGORY_SECTION_SIZE), more: open.length > CATEGORY_SECTION_SIZE });
  }
  sections.push({ kind: "all", cards: cards.filter((card) => !isConnected(card.slug)) });
  return sections;
}
