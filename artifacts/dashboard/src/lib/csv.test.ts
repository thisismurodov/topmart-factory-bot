import { describe, expect, it } from "vitest";
import { csvEscape, toCsv } from "./csv";

describe("csvEscape", () => {
  it("oddiy matn o'zgarmaydi", () => {
    expect(csvEscape("Olim aka do'koni")).toBe("Olim aka do'koni");
    expect(csvEscape("125000")).toBe("125000");
  });

  it("vergul, qo'shtirnoq va yangi qator qo'shtirnoqqa olinadi", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('u "katta" dedi')).toBe('"u ""katta"" dedi"');
    expect(csvEscape("bir\nikki")).toBe('"bir\nikki"');
  });

  it("formula-boshlovchi qiymatlar apostrof bilan neytrallanadi", () => {
    expect(csvEscape("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvEscape("+998901234567")).toBe("'+998901234567");
    expect(csvEscape("-oldi")).toBe("'-oldi");
    expect(csvEscape("@dokon")).toBe("'@dokon");
    expect(csvEscape("\t=HYPERLINK()")).toBe("'\t=HYPERLINK()");
  });

  it("bosh joy bilan yashiringan formula ham ushlanadi", () => {
    expect(csvEscape("  =1+2")).toBe("'  =1+2");
  });

  it("formula + vergul birga: avval apostrof, keyin qo'shtirnoq", () => {
    expect(csvEscape("=cmd,x")).toBe("\"'=cmd,x\"");
  });
});

describe("toCsv", () => {
  it("qatorlarni CRLF bilan birlashtiradi va har katakni qochiradi", () => {
    const csv = toCsv([
      ["Agent", "Do'kon", "Summa"],
      ["Ali", "=Evil, do'kon", "125000"],
    ]);
    expect(csv).toBe("Agent,Do'kon,Summa\r\nAli,\"'=Evil, do'kon\",125000");
  });
});
