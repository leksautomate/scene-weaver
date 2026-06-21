import fs from "fs";
import path from "path";

export const BG_MUSIC_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"];

export const BG_MUSIC_DIR = path.join(process.cwd(), "bg_music");

/** Scan a directory for supported background-music files. Returns sorted absolute paths. */
export function scanBgMusicTracks(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => BG_MUSIC_EXTS.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}
