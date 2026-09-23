// Form fields: the inventory Iris asks for at upload, and setting values by
// the contract in spec §9.2.
import * as mupdf from "mupdf";
import { IrisPdfError, EXIT, type Warning } from "../report.ts";
import type { Box } from "../align/words.ts";

export type FieldType = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "button" | "signature";

export type Field = {
  name: string;
  type: FieldType;
  page: number; // 1-based, the page of its first widget
  rect: Box; // the first widget, in PDF user space
  options: string[]; // choices, or a checkbox's on-state, or a radio group's states
  required: boolean;
  readonly: boolean;
  maxlen: number | null;
  editable: boolean; // a combo box that accepts any text
  multiSelect: boolean;
};

export type Widget = { name: string; page: number; widget: mupdf.PDFWidget; field: mupdf.PDFObject };

export type FormValue = string | boolean | string[];

// Every widget in the document, with the terminal field it belongs to.
export function allWidgets(doc: mupdf.PDFDocument): Widget[] {
  const out: Widget[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    for (const widget of doc.loadPage(i).getWidgets()) {
      const obj = widget.getObject();
      // A widget with no /T of its own is one of its parent field's widgets.
      const field = obj.get("T").isNull() && !obj.get("Parent").isNull() ? obj.get("Parent") : obj;
      out.push({ name: widget.getName(), page: i, widget, field });
    }
  }
  return out;
}

// A button widget's states, from its normal appearances: the on-states, never Off.
export function onStates(widget: mupdf.PDFWidget): string[] {
  const states: string[] = [];
  const n = widget.getObject().get("AP", "N");
  if (n.isDictionary()) n.forEach((_, key) => { if (key !== "Off") states.push(String(key)); });
  return states;
}

function typeOf(w: mupdf.PDFWidget): FieldType {
  if (w.isPushButton()) return "button";
  if (w.isCheckbox()) return "checkbox";
  if (w.isRadioButton()) return "radio";
  if (w.isText()) return "text";
  if (w.isComboBox()) return "combobox";
  if (w.isListBox()) return "listbox";
  return "signature";
}

export function inventory(doc: mupdf.PDFDocument): Field[] {
  const fields = new Map<string, Field>();
  for (const { name, page, widget } of allWidgets(doc)) {
    const type = typeOf(widget);
    const flags = widget.getFieldFlags();
    const f = fields.get(name);
    if (f) {
      // More widgets of one field: a radio group's options, or a repeated field.
      for (const s of type === "radio" ? onStates(widget) : []) if (!f.options.includes(s)) f.options.push(s);
      continue;
    }
    const r = widget.getObject().get("Rect");
    const rect = [0, 1, 2, 3].map((k) => r.get(k).asNumber()) as Box;
    fields.set(name, {
      name, type, page: page + 1,
      rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
      options: type === "checkbox" || type === "radio" ? onStates(widget) : widget.isChoice() ? widget.getOptions() : [],
      required: (flags & mupdf.PDFWidget.FIELD_IS_REQUIRED) !== 0,
      readonly: widget.isReadOnly(),
      maxlen: type === "text" && widget.getMaxLen() > 0 ? widget.getMaxLen() : null,
      editable: widget.isChoice() && (flags & mupdf.PDFWidget.CH_FIELD_IS_EDIT) !== 0,
      multiSelect: widget.isChoice() && (flags & mupdf.PDFWidget.CH_FIELD_IS_MULTI_SELECT) !== 0,
    });
  }
  return [...fields.values()];
}

const bad = (name: string, why: string) => new IrisPdfError("bad_value", `Field "${name}": ${why}`, EXIT.badInput);

// Check every value before anything is changed. Values are never echoed back
// in messages: they may be personal data.
export function checkValues(fields: Field[], values: Record<string, FormValue>): Warning[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const nowhere = Object.keys(values).filter((n) => !byName.has(n));
  if (nowhere.length) {
    throw new IrisPdfError("no_acroform_field", `No form field in the PDF for: ${nowhere.join(", ")}`);
  }
  const warnings: Warning[] = [];
  for (const [name, v] of Object.entries(values)) {
    const f = byName.get(name)!;
    if (f.type === "button") throw new IrisPdfError("field_not_settable", `Field "${name}" is a push button.`, EXIT.badInput);
    if (f.type === "signature") warnings.push({ code: "signature_field_skipped", detail: name });
    else if (f.type === "text") {
      if (typeof v !== "string") throw bad(name, "a text field takes a string.");
      if (f.maxlen !== null && [...v].length > f.maxlen) throw bad(name, `longer than its limit of ${f.maxlen} characters.`);
    } else if (f.type === "checkbox") {
      if (typeof v !== "boolean") throw bad(name, "a checkbox takes true or false.");
    } else if (f.type === "radio") {
      if (typeof v !== "string" || !f.options.includes(v)) throw bad(name, `must be one of: ${f.options.join(", ")}.`);
    } else {
      const list = Array.isArray(v) ? v : [v];
      if (Array.isArray(v) && !f.multiSelect) throw bad(name, "takes one choice, not a list.");
      if (!list.every((x) => typeof x === "string")) throw bad(name, "a choice is a string.");
      if (!f.editable && !list.every((x) => f.options.includes(x))) throw bad(name, `must be one of: ${f.options.join(", ")}.`);
    }
  }
  return warnings;
}

// Set values through mupdf's widget API, which redraws each appearance.
// Returns the rectangles (per page index, in page space) that may now differ.
export function setValues(doc: mupdf.PDFDocument, fields: Field[], values: Record<string, FormValue>) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const changed = new Map<number, Box[]>();
  let set = 0, skippedReadOnly = 0;
  const widgets = allWidgets(doc);
  for (const [name, value] of Object.entries(values)) {
    const f = byName.get(name)!;
    if (f.type === "signature") continue;
    if (f.readonly) {
      skippedReadOnly++;
      continue;
    }
    const mine = widgets.filter((w) => w.name === name);
    for (const w of mine) {
      if (f.type === "checkbox" || f.type === "radio") {
        // Checked: the widget's own on-state. Unchecked: always /Off, whatever
        // the source used for "off" (Off, empty or missing).
        const want = value === true ? onStates(w.widget)[0] : typeof value === "string" && onStates(w.widget).includes(value) ? value : "Off";
        w.widget.getObject().put("AS", doc.newName(want));
        if (want !== "Off" || f.type === "checkbox") w.field.put("V", doc.newName(want));
      } else {
        if (f.type === "text") w.widget.setTextValue(value as string);
        else if (Array.isArray(value)) w.field.put("V", value.map((x) => doc.newString(x)));
        else w.widget.setChoiceValue(value as string);
        w.widget.update();
      }
      const list = changed.get(w.page) ?? [];
      list.push(w.widget.getBounds() as Box);
      changed.set(w.page, list);
    }
    set++;
  }
  return { set, skippedReadOnly, changed };
}
