// The library API. tag() makes the tagged PDF; fields() lists a PDF's form
// fields, which is what Iris asks for at upload time. review() is an optional AI review.
import { openPdf, type OpenOptions } from "./pdf/document.ts";
import { inventory, type Field } from "./pdf/widgets.ts";

export { tag, type PagesInput, type TagOptions } from "./tag.ts";
export { newReport, IrisPdfError, EXIT, VERSION, type Report, type Warning } from "./report.ts";
export type { Field, FormValue } from "./pdf/widgets.ts";
export { review, type ReviewOptions, type ReviewReport, type Finding } from "./review/review.ts";

export function fields(pdf: Uint8Array, opts: OpenOptions = {}): Field[] {
  return inventory(openPdf(pdf, { ...opts, readOnly: true }).doc);
}
