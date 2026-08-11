// CSV yordamchilari — Kunlik tashriflar eksporti va boshqa jadval eksportlari uchun.
// Excel formula-injection himoyasi bilan: `=`, `+`, `-`, `@` (yoki TAB/CR) bilan
// boshlanadigan qiymatlar apostrof bilan neytrallanadi, keyin standart CSV
// qochirish (vergul/qo'shtirnoq/yangi qator) qo'llanadi.

export function csvEscape(v: string): string {
  let s = v;
  if (/^\s*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

// BOM — Excel UTF-8 (o'zbekcha apostroflar) to'g'ri ochilishi uchun
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
