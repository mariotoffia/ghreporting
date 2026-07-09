import { describe, expect, it } from "bun:test";
import { createEventBus } from "./bus";
import { recordingLogger } from "./testutil";

describe("createEventBus", () => {
  it("delivers only to matching type", () => {
    const bus = createEventBus(recordingLogger());
    const got: string[] = [];
    bus.on("auth.unlocked", () => got.push("a"));
    bus.on("sync.started", (e) => got.push(e.dataset));
    bus.emit({ type: "sync.started", dataset: "x", scope: "acme" });
    expect(got).toEqual(["x"]);
  });

  it("delivers to every listener of a type in registration order", () => {
    const bus = createEventBus(recordingLogger());
    const got: string[] = [];
    bus.on("auth.unlocked", () => got.push("first"));
    bus.on("auth.unlocked", () => got.push("second"));
    bus.emit({ type: "auth.unlocked" });
    expect(got).toEqual(["first", "second"]);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createEventBus(recordingLogger());
    const got: string[] = [];
    const off = bus.on("auth.unlocked", () => got.push("a"));
    off();
    bus.emit({ type: "auth.unlocked" });
    expect(got).toEqual([]);
  });

  it("unsubscribe removes only the one listener, not others of the same type", () => {
    const bus = createEventBus(recordingLogger());
    const got: string[] = [];
    const offA = bus.on("auth.unlocked", () => got.push("a"));
    bus.on("auth.unlocked", () => got.push("b"));
    offA();
    bus.emit({ type: "auth.unlocked" });
    expect(got).toEqual(["b"]);
  });

  it("a throwing listener does not break the others and is logged", () => {
    const log = recordingLogger();
    const bus = createEventBus(log);
    const got: string[] = [];
    bus.on("auth.unlocked", () => {
      throw new Error("boom");
    });
    bus.on("auth.unlocked", () => got.push("second"));
    bus.emit({ type: "auth.unlocked" });
    expect(got).toEqual(["second"]);
    expect(log.lines.some((l) => l.level === "error")).toBe(true);
  });

  it("a listener that unsubscribes another during dispatch does not skip the in-flight event", () => {
    const bus = createEventBus(recordingLogger());
    const got: string[] = [];
    let offB = () => {};
    bus.on("auth.unlocked", () => {
      got.push("a");
      offB(); // remove B mid-dispatch — B was subscribed when emit started, so it still fires
    });
    offB = bus.on("auth.unlocked", () => got.push("b"));
    bus.emit({ type: "auth.unlocked" });
    expect(got).toEqual(["a", "b"]);
  });

  it("emitting a type with no listeners is a no-op", () => {
    const bus = createEventBus(recordingLogger());
    expect(() => bus.emit({ type: "notification.changed", id: 1 })).not.toThrow();
  });
});
