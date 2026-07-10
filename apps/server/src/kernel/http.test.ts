import { describe, expect, it } from "bun:test";
import { ValidationError } from "./errors";
import { capBytes, jsonObject, nonEmpty } from "./http";

describe("nonEmpty", () => {
  it("returns a non-blank string", () => {
    expect(nonEmpty("acme", "org")).toBe("acme");
  });

  it("rejects blank, non-string, and missing values", () => {
    expect(() => nonEmpty("  ", "name")).toThrow(ValidationError);
    expect(() => nonEmpty(undefined, "name")).toThrow(/name is required/);
    expect(() => nonEmpty(42, "name")).toThrow(ValidationError);
  });
});

describe("jsonObject", () => {
  const reqOf = (parse: () => Promise<unknown>) => ({ json: parse });

  it("returns a parsed JSON object", async () => {
    expect(await jsonObject(reqOf(async () => ({ a: 1 })))).toEqual({ a: 1 });
  });

  it("rejects null, arrays, and primitives with a 400", async () => {
    await expect(jsonObject(reqOf(async () => null))).rejects.toThrow(ValidationError);
    await expect(jsonObject(reqOf(async () => [1, 2]))).rejects.toThrow(/JSON object/);
    await expect(jsonObject(reqOf(async () => "x"))).rejects.toThrow(ValidationError);
  });

  it("rejects a body that is not JSON", async () => {
    await expect(
      jsonObject(
        reqOf(async () => {
          throw new Error("bad json");
        }),
      ),
    ).rejects.toThrow(/body must be JSON/);
  });
});

describe("capBytes", () => {
  it("returns the string when within the cap", () => {
    expect(capBytes("hello", 10, "field")).toBe("hello");
  });

  it("measures UTF-8 byte length, not code-point count", () => {
    // "€" is 3 UTF-8 bytes: within a 3-byte cap, over a 2-byte cap.
    expect(capBytes("€", 3, "field")).toBe("€");
    expect(() => capBytes("€", 2, "field")).toThrow(ValidationError);
  });

  it("names the field in the message", () => {
    expect(() => capBytes("toolong", 3, "definition")).toThrow(/definition exceeds/);
  });
});
