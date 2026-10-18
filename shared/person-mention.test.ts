import { describe, expect, it } from "vitest";

import { personMentionExcerpt, personMentionRanges, personTagNames } from "./person-mention.ts";

const tags = (text: string, options = {}) => personMentionRanges(text, options).map(({ start, end }) => text.slice(start, end));

describe("the person's tag", () => {
  it("always accepts @you, in any case, at a mention boundary", () => {
    expect(tags("@you, @YOU and (@You) **@you**")).toEqual(["@you", "@YOU", "@You", "@you"]);
  });

  it("is not an email, a URL path or the start of a longer word", () => {
    expect(tags("mail user@you.com, see /@you, @young @your @you_ok @you2 @youé")).toEqual([]);
  });

  it("accepts the profile name when one is set, and only then", () => {
    expect(tags("@Sam and @sam, not @Samx", { profileName: "Sam" })).toEqual(["@Sam", "@sam"]);
    expect(tags("@Sam", { profileName: "" })).toEqual([]);
    expect(tags("@Sam", { profileName: "   " })).toEqual([]);
    expect(tags("@Sam")).toEqual([]);
    expect(tags("@Ada Lovelace please", { profileName: "  Ada   Lovelace " })).toEqual(["@Ada Lovelace"]);
  });

  it("gives way to a bot with the same name, or a longer one", () => {
    expect(tags("@you", { botNames: ["You"] })).toEqual([]);
    expect(tags("@Sam look", { profileName: "Sam", botNames: ["sam"] })).toEqual([]);
    expect(tags("@Sam Bot, ask @Sam", { profileName: "Sam", botNames: ["Sam Bot"] })).toEqual(["@Sam"]);
    expect(tags("@Sam Smith", { profileName: "Sam Smith", botNames: ["Sam"] })).toEqual(["@Sam Smith"]);
  });

  it("leaves @everyone alone, even for a person who named themselves that", () => {
    expect(tags("@everyone @all", { profileName: "everyone" })).toEqual([]);
    expect(personTagNames("everyone")).toEqual(["you"]);
    expect(personTagNames("You")).toEqual(["you"]);
  });
});

describe("the line a mention notification quotes", () => {
  it("is the line that carries the tag", () => {
    const text = "Draft is up.\n@you three open questions are blocking Section 2 & 3.\nMore later.";
    expect(personMentionExcerpt(text)).toBe("@you three open questions are blocking Section 2 & 3.");
  });

  it("widens to the paragraph when the line is only the tag", () => {
    const text = "Intro.\n\n@you\nWhich bucket should the export use?\n\nUnrelated tail.";
    expect(personMentionExcerpt(text)).toBe("@you\nWhich bucket should the export use?");
  });

  it("is null without a tag, and ignores tags quoted in code", () => {
    expect(personMentionExcerpt("All done, nothing for anyone.")).toBeNull();
    expect(personMentionExcerpt("Run `notify @you` or\n```\n@you\n```")).toBeNull();
    expect(personMentionExcerpt("~~~\n@you\n~~~")).toBeNull();
    expect(personMentionExcerpt("````\n```\n@you\n```\n````")).toBeNull();
    expect(personMentionExcerpt("~~~\n```\n~~~\n@you please check the export bucket")).toBe("@you please check the export bucket");
    expect(personMentionExcerpt("```\nunclosed @you")).toBeNull();
    expect(personMentionExcerpt("See ``type @you here`` for the syntax.")).toBeNull();
    expect(personMentionExcerpt("Wrap `the\n@you` tag in code.")).toBeNull();
    expect(personMentionExcerpt("Use `code` and then @you decide which bucket wins")).toBe("Use `code` and then @you decide which bucket wins");
    expect(personMentionExcerpt("@you", { botNames: ["you"] })).toBeNull();
  });
});
