import { describe, it, expect } from "vitest";

// Pure utility functions extracted from the TTV feature

function parsePromptLines(raw: string): string[] {
  return raw.split("\n").map(l => l.trim()).filter(Boolean);
}

function padIndex(index: number): string {
  return String(index).padStart(3, "0");
}

function calcProgress(items: Array<{ status: string }>): number {
  const terminal = items.filter(i => i.status === "completed" || i.status === "failed").length;
  return items.length === 0 ? 0 : Math.round((terminal / items.length) * 100);
}

describe("parsePromptLines", () => {
  it("splits on newlines and trims", () => {
    expect(parsePromptLines("a\n b \nc")).toEqual(["a", "b", "c"]);
  });
  it("filters blank lines", () => {
    expect(parsePromptLines("a\n\n\nb")).toEqual(["a", "b"]);
  });
  it("returns empty array for blank input", () => {
    expect(parsePromptLines("   \n  \n")).toEqual([]);
  });
});

describe("padIndex", () => {
  it("pads single digit", () => expect(padIndex(1)).toBe("001"));
  it("pads double digit", () => expect(padIndex(42)).toBe("042"));
  it("leaves triple digit", () => expect(padIndex(100)).toBe("100"));
});

describe("calcProgress", () => {
  it("returns 0 for all pending", () => {
    expect(calcProgress([{ status: "pending" }, { status: "pending" }])).toBe(0);
  });
  it("returns 50 for half done", () => {
    expect(calcProgress([{ status: "completed" }, { status: "pending" }])).toBe(50);
  });
  it("counts failed as terminal", () => {
    expect(calcProgress([{ status: "failed" }, { status: "pending" }])).toBe(50);
  });
  it("returns 100 when all terminal", () => {
    expect(calcProgress([{ status: "completed" }, { status: "failed" }])).toBe(100);
  });
  it("returns 0 for empty array", () => {
    expect(calcProgress([])).toBe(0);
  });
});
