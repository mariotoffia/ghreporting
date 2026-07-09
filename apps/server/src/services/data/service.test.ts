import { afterEach, describe, expect, it } from "bun:test";
import { buildApp } from "../../app";
import type { NotificationInput } from "../../kernel/ports";
import type { DatasetConnector, DatasetQuery, GitHubClient } from "./ports";
import { createDataService } from "./service";

const gh = {} as GitHubClient;

function fakeConnector(id = "fake-ds", calls: string[] = []): DatasetConnector {
  let synced = false;
  return {
    meta: {
      id,
      title: "Fake dataset",
      description: "test double",
      columns: [
        { name: "day", type: "date", description: "day" },
        { name: "n", type: "number", description: "count" },
      ],
      scope: "org",
      freshnessTtlHours: 24,
    },
    coverage: (_db, q) => {
      calls.push("coverage");
      return synced ? [] : [{ scope: q.org, from: q.range.from, to: q.range.to }];
    },
    fetch: async function* (gap) {
      calls.push("fetch");
      yield [{ day: gap.from, n: 1 }];
    },
    upsert: () => {
      calls.push("upsert");
      synced = true;
    },
    select: (_db, q) => {
      calls.push(`select:limit=${q.limit}`);
      return { columns: [], rows: [["2026-07-01", 1]] };
    },
  };
}

let harness: ReturnType<typeof buildApp>;
let notes: NotificationInput[];

async function start(...connectors: DatasetConnector[]) {
  harness = buildApp({ GHR_DB_PATH: ":memory:" });
  notes = [];
  harness.bind.bindNotify((n) => notes.push(n));
  const data = createDataService({ gh, connectors });
  harness.kernel.register(data);
  await harness.kernel.start(harness.app);
  return data;
}

afterEach(async () => {
  await harness?.kernel.stop();
  harness?.ctx.db.close();
});

const q: DatasetQuery = { org: "acme", range: { from: "2026-07-01", to: "2026-07-05" } };

describe("data service", () => {
  it("syncs the gap then answers locally (coverage→fetch→upsert→select)", async () => {
    const calls: string[] = [];
    const data = await start(fakeConnector("fake-ds", calls));
    const rs = await data.queryDataset("fake-ds", q);
    expect(rs.rows).toEqual([["2026-07-01", 1]]);
    expect(rs.stale).toBeUndefined();
    expect(calls).toEqual(["coverage", "fetch", "upsert", "select:limit=undefined"]);
  });

  it("sync:false never touches fetch but still selects", async () => {
    const calls: string[] = [];
    const data = await start(fakeConnector("fake-ds", calls));
    const rs = await data.queryDataset("fake-ds", q, { sync: false });
    expect(rs.rows).toHaveLength(1);
    expect(calls).toEqual(["select:limit=undefined"]);
  });

  it("fetch failure serves stale, notifies, and emits sync.failed", async () => {
    const broken = fakeConnector("fake-ds");
    broken.fetch = () => {
      throw new Error("github down");
    };
    const data = await start(broken);
    const failed: string[] = [];
    harness.ctx.bus.on("sync.failed", (e) => failed.push(e.dataset));
    const rs = await data.queryDataset("fake-ds", q);
    expect(rs.stale).toBe(true);
    expect(rs.rows).toHaveLength(1); // stale serve: local data still answers
    expect(failed).toEqual(["fake-ds"]);
    expect(notes[0]?.key).toBe("sync.fake-ds.failed");
  });

  it("duplicate connector registration throws connector.duplicate", async () => {
    const data = await start(fakeConnector());
    expect(() => data.registerConnector(fakeConnector())).toThrow("fake-ds");
    try {
      data.registerConnector(fakeConnector());
    } catch (e) {
      expect((e as { code: string }).code).toBe("connector.duplicate");
      expect((e as { status: number }).status).toBe(409);
    }
  });

  it("unknown dataset → 404 envelope through the route", async () => {
    await start(fakeConnector());
    const res = await harness.app.request("/api/data/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataset: "nope", q }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("GET /datasets lists meta plus coverage", async () => {
    const data = await start(fakeConnector());
    await data.queryDataset("fake-ds", q); // creates a watermark
    const res = await harness.app.request("/api/data/datasets");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      id: string;
      coverage: Array<{ scope: string; status: string }>;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("fake-ds");
    expect(list[0]?.coverage[0]).toMatchObject({ scope: "acme", status: "idle" });
  });

  it("POST /query validates org and range and clamps limit to 1000", async () => {
    const calls: string[] = [];
    await start(fakeConnector("fake-ds", calls));
    const post = (body: unknown) =>
      harness.app.request("/api/data/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post({ dataset: "fake-ds", q: { ...q, org: "" } })).status).toBe(400);
    expect(
      (
        await post({
          dataset: "fake-ds",
          q: { ...q, range: { from: "2026-07-05", to: "2026-07-01" } },
        })
      ).status,
    ).toBe(400);

    const ok = await post({ dataset: "fake-ds", q: { ...q, limit: 5000 }, sync: false });
    expect(ok.status).toBe(200);
    expect(calls).toEqual(["select:limit=1000"]);
  });

  it("POST /sync fills gaps and reports the summary", async () => {
    await start(fakeConnector());
    const res = await harness.app.request("/api/data/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataset: "fake-ds", org: "acme", range: q.range }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: true, stale: false });
  });
});
