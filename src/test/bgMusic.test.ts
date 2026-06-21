import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scanBgMusicTracks } from "../../server/lib/bgMusic";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bgmusic-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanBgMusicTracks", () => {
  it("returns [] when directory does not exist", () => {
    expect(scanBgMusicTracks(path.join(tmpDir, "nope"))).toEqual([]);
  });

  it("returns [] when directory is empty", () => {
    expect(scanBgMusicTracks(tmpDir)).toEqual([]);
  });

  it("returns only supported audio files, sorted, as absolute paths", () => {
    fs.writeFileSync(path.join(tmpDir, "b.mp3"), "x");
    fs.writeFileSync(path.join(tmpDir, "a.wav"), "x");
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "x");
    fs.writeFileSync(path.join(tmpDir, "c.MP3"), "x");
    const result = scanBgMusicTracks(tmpDir);
    expect(result.map(p => path.basename(p))).toEqual(["a.wav", "b.mp3", "c.MP3"]);
    expect(result.every(p => path.isAbsolute(p))).toBe(true);
  });
});
