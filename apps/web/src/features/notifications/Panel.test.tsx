import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import type { NotificationCard } from "./badge";
import { Panel } from "./Panel";

const now = Date.parse("2026-07-09T12:00:00.000Z");

function card(p: Partial<NotificationCard>): NotificationCard {
  return {
    id: 1,
    key: "k",
    level: "error",
    title: "Bad PAT",
    body: "The stored token was rejected.",
    source: "credentials",
    created_at: "2026-07-09T11:00:00.000Z",
    updated_at: "2026-07-09T11:00:00.000Z",
    read_at: null,
    dismissed_at: null,
    ...p,
  };
}

describe("Panel", () => {
  it("renders a card's title, body and relative time", () => {
    const html = renderToString(
      <Panel list={[card({})]} now={now} onRead={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain("Bad PAT");
    expect(html).toContain("The stored token was rejected.");
    expect(html).toContain("1 h ago");
  });

  it("shows an empty state when there are no cards", () => {
    const html = renderToString(
      <Panel list={[]} now={now} onRead={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain("Nothing needs attention.");
  });

  it("hides Mark read once a card is read", () => {
    const read = renderToString(
      <Panel
        list={[card({ read_at: "2026-07-09T11:30:00.000Z" })]}
        now={now}
        onRead={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(read).not.toContain("Mark read");
    expect(read).toContain("Dismiss");
  });
});
