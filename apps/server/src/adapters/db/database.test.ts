import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openReadOnly } from "./database";

describe("openReadOnly", () => {
  const opened: { close(): void }[] = [];
  const tmpPath = () => join(mkdtempSync(join(tmpdir(), "ghr-ro-")), "ghreporting.db");
  afterEach(() => {
    for (const h of opened.splice(0)) h.close();
  });

  it("reads rows the read-write handle wrote", () => {
    const path = tmpPath();
    const rw = openDatabase(path);
    opened.push(rw);
    rw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('x');");
    const ro = openReadOnly(path);
    opened.push(ro);
    expect(ro.query("SELECT a FROM t").values()).toEqual([["x"]]);
  });

  it("rejects an INSERT — proving the write guard is at the driver", () => {
    const path = tmpPath();
    const rw = openDatabase(path);
    opened.push(rw);
    rw.exec("CREATE TABLE t(a TEXT);");
    const ro = openReadOnly(path);
    opened.push(ro);
    expect(() => ro.exec("INSERT INTO t VALUES ('y')")).toThrow(/readonly/);
  });

  it("rejects DDL (CREATE TABLE)", () => {
    const path = tmpPath();
    const rw = openDatabase(path);
    opened.push(rw);
    rw.exec("CREATE TABLE t(a TEXT);");
    const ro = openReadOnly(path);
    opened.push(ro);
    expect(() => ro.exec("CREATE TABLE evil(x)")).toThrow(/readonly/);
  });
});
