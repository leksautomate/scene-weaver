import { describe, it, expect, beforeEach } from "vitest";
import { loadProviderSettings, saveProviderSettings } from "../lib/providers";

describe("skipImageGeneration setting", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to false when no settings saved", () => {
    const settings = loadProviderSettings();
    expect(settings.skipImageGeneration).toBe(false);
  });

  it("persists true when saved", () => {
    saveProviderSettings({ ...loadProviderSettings(), skipImageGeneration: true });
    const loaded = loadProviderSettings();
    expect(loaded.skipImageGeneration).toBe(true);
  });

  it("persists false when saved", () => {
    saveProviderSettings({ ...loadProviderSettings(), skipImageGeneration: false });
    const loaded = loadProviderSettings();
    expect(loaded.skipImageGeneration).toBe(false);
  });
});

describe("inworld settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("has correct defaults when no settings saved", () => {
    const settings = loadProviderSettings();
    expect(settings.inworldApiKey).toBe("");
    expect(settings.textProvider).toBe("groq");
  });

  it("persists inworld settings when saved", () => {
    saveProviderSettings({
      ...loadProviderSettings(),
      inworldApiKey: "test-key-123",
      textProvider: "inworld",
    });
    const loaded = loadProviderSettings();
    expect(loaded.inworldApiKey).toBe("test-key-123");
    expect(loaded.textProvider).toBe("inworld");
  });
});

describe("background music settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("has correct defaults when no settings saved", () => {
    const settings = loadProviderSettings();
    expect(settings.bgMusicEnabled).toBe(true);
    expect(settings.bgMusicVolume).toBe(0.10);
    expect(settings.narrationVolume).toBe(2.0);
  });

  it("persists background music settings when saved", () => {
    saveProviderSettings({
      ...loadProviderSettings(),
      bgMusicEnabled: false,
      bgMusicVolume: 0.25,
      narrationVolume: 1.5,
    });
    const loaded = loadProviderSettings();
    expect(loaded.bgMusicEnabled).toBe(false);
    expect(loaded.bgMusicVolume).toBe(0.25);
    expect(loaded.narrationVolume).toBe(1.5);
  });
});
