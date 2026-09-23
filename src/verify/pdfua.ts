// PDF/UA-1 validation with veraPDF, when it is installed. Optional: the
// report's pdfua block says { checked: false } until this is wired in (M9).
import { spawnSync } from "node:child_process";

export function checkPdfUa(path: string): { passed: boolean | null; message: string } {
  const run = spawnSync("verapdf", ["--flavour", "ua1", "--format", "text", path], { encoding: "utf8" });
  if (run.error) return { passed: null, message: "veraPDF is not installed; PDF/UA-1 was not checked." };
  const passed = /^PASS\b/m.test(run.stdout);
  return { passed, message: run.stdout.trim() || run.stderr.trim() };
}
