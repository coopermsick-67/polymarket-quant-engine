import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isUsableCalibration, setActiveCalibration, type StackingCalibration } from "../app/lib/polymarket-data";
import type { CalibrationFitReport } from "../app/lib/model-calibration";

/**
 * Load a stacking calibration written by `pnpm run calibrate` and install it
 * for every probability in this process. A missing or unusable file leaves the
 * conservative prior in place and says why.
 */
export const loadCalibrationFile = async (filename: string): Promise<{ active: StackingCalibration | null; reason: string }> => {
  try {
    const parsed = JSON.parse(await readFile(filename, "utf8")) as { calibration?: unknown; reason?: unknown };
    const active = setActiveCalibration(parsed.calibration ?? null);
    if (active) return { active, reason: "fitted" };
    return { active: null, reason: typeof parsed.reason === "string" ? parsed.reason : "the saved fit is not usable" };
  } catch (error) {
    setActiveCalibration(null);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: null, reason: `no calibration file at ${filename}` };
    return { active: null, reason: `the calibration file could not be read (${error instanceof Error ? error.message : "unknown error"})` };
  }
};

export const saveCalibrationFile = async (filename: string, report: CalibrationFitReport): Promise<void> => {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  const payload = { ...report, calibration: report.calibration && isUsableCalibration(report.calibration) ? report.calibration : null };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filename);
};
