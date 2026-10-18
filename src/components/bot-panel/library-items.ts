import { attachmentBasename } from "@/lib/composer-attachments";
import { visibleMessages, type Bot } from "@/state/store";
import { collectMessageFiles, splitMessageAttachments } from "../AttachmentGallery";

export interface LibraryItem {
  key: string;
  name: string;
  kind: "image" | "file";
  at: number;
  messageId: string;
}

export function botLibraryItems(bot: Bot): LibraryItem[] {
  const groups: LibraryItem[][] = [];
  const seen = new Set<string>();
  for (const message of [...visibleMessages(bot)].reverse()) {
    const items: LibraryItem[] = [];
    groups.push(items);
    if (message.role !== "bot" || message.kind !== "text") continue;
    const attached = splitMessageAttachments(message.attachments);
    const files = [
      ...attached.files,
      ...collectMessageFiles(message.text ?? "", [...attached.images, ...attached.files.map((file) => file.path)]),
    ];
    const add = (path: string, name: string, kind: LibraryItem["kind"]) => {
      if (seen.has(path)) return;
      seen.add(path);
      items.push({ key: `${message.id}:${path}`, name, kind, at: message.at, messageId: message.id });
    };
    for (const image of attached.images) add(image, attachmentBasename(image), "image");
    for (const file of files) add(file.path, file.name || attachmentBasename(file.path), "file");
  }
  return groups.flat();
}

export function isPageItem(item: Pick<LibraryItem, "name" | "kind">): boolean {
  return item.kind === "file" && /\.html?$/i.test(item.name);
}

export function memoryEntries(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((entry): entry is string => Boolean(entry));
}
