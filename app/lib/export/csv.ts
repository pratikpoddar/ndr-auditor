/**
 * CSV escaping.
 *
 * The leading-character guard matters: a message field starting with = + - or @ is executed
 * as a formula when the export is opened in Excel. Courier messages are attacker-influenceable
 * free text, so every field is prefixed with a quote when it starts with one of those.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 correctly — Indian addresses and names need it.
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
