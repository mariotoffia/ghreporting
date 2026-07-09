import { describe, expect, it } from "bun:test";
import { badgeCount, type NotificationCard, relativeTime, worstLevel } from "./badge";

/** Build a card with only the fields the pure helpers read. */
function card(p: Partial<NotificationCard>): NotificationCard {
  return {
    id: 1,
    key: "k",
    level: "info",
    title: "t",
    body: null,
    source: "s",
    created_at: "2026-07-09T00:00:00.000Z",
    updated_at: "2026-07-09T00:00:00.000Z",
    read_at: null,
    dismissed_at: null,
    ...p,
  };
}

describe("badgeCount", () => {
  it("counts unread, undismissed cards", () => {
    const list = [
      card({ id: 1 }),
      card({ id: 2, read_at: "2026-07-09T01:00:00.000Z" }),
      card({ id: 3, dismissed_at: "2026-07-09T01:00:00.000Z" }),
      card({ id: 4 }),
    ];
    expect(badgeCount(list)).toBe(2);
  });
  it("is 0 for an empty list", () => {
    expect(badgeCount([])).toBe(0);
  });
});

describe("worstLevel", () => {
  it("returns the highest severity present", () => {
    expect(worstLevel([card({ level: "info" }), card({ level: "warning" })])).toBe("warning");
    expect(worstLevel([card({ level: "info" }), card({ level: "error" })])).toBe("error");
    expect(worstLevel([card({ level: "warning" })])).toBe("warning");
  });
  it("defaults to info for an empty list", () => {
    expect(worstLevel([])).toBe("info");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-07-09T12:00:00.000Z");
  it("renders just now under a minute", () => {
    expect(relativeTime("2026-07-09T11:59:30.000Z", now)).toBe("just now");
  });
  it("renders minutes, hours, and days", () => {
    expect(relativeTime("2026-07-09T11:30:00.000Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-07-09T10:00:00.000Z", now)).toBe("2 h ago");
    expect(relativeTime("2026-07-07T12:00:00.000Z", now)).toBe("2 d ago");
  });
});
