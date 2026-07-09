import { describe, expect, it } from "bun:test";
import { premiumRequestCost, roundUsd } from "./usage";

describe("premiumRequestCost", () => {
  it("is zero while inside the included allowance", () => {
    expect(premiumRequestCost({ requests: 300, multiplier: 1, included: 300 })).toBe(0);
  });

  it("bills only the overage at the default price", () => {
    // 350 - 300 included = 50 requests × $0.04 = $2.00
    expect(premiumRequestCost({ requests: 350, multiplier: 1, included: 300 })).toBe(2);
  });

  it("applies the model multiplier before the allowance", () => {
    // 100 × 0.33 = 33 billable × $0.04 = $1.32
    expect(premiumRequestCost({ requests: 100, multiplier: 0.33 })).toBe(1.32);
  });

  it("honours a custom price per request", () => {
    expect(premiumRequestCost({ requests: 10, multiplier: 10, pricePerRequestUsd: 0.1 })).toBe(10);
  });

  it("rejects negative inputs", () => {
    expect(() => premiumRequestCost({ requests: -1, multiplier: 1 })).toThrow(RangeError);
  });
});

describe("roundUsd", () => {
  it("rounds to whole cents without float dust", () => {
    expect(roundUsd(1.005)).toBe(1.01);
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});
