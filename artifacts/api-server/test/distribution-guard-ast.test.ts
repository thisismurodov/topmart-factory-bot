import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// AST-guard: savdo botdagi persist-nuqtalar (create_sale, record_pul_olish,
// pay_nasiya_fifo) faqat rad etuvchi dokon-egalik guard'idan KEYIN va AYNAN
// O'SHA dokon_id bilan chaqirilishini statik tasdiqlaydi.
//
// Analiz qoidalari (oddiy "nomi bor / satri oldinroq" tekshiruvi EMAS):
//   1. Dominance: guard faqat `if not _dokon_ruxsat_guard(uid, <dokon>, ...):`
//      ko'rinishida bo'lib, body'si return/raise bilan tugasagina keyingi
//      statement'larni himoyalangan deb hisoblaydi. Boshqa branch ichidagi
//      guard tashqaridagi persist chaqiriqni himoyalamaydi.
//   2. ID mosligi: guard'ning dokon argumenti (2-pozitsiya) persist
//      chaqiriqning dokon argumenti (1-pozitsiya) bilan ast.unparse bo'yicha
//      bir xil bo'lishi shart — begona/boshqa o'zgaruvchi ID o'tmaydi.
//   3. Nested funksiyalar alohida tahlil qilinadi — ota funksiya tahliliga
//      ularning chaqiriqlari qo'shilmaydi.
//
// Mutation-fixture testlari analizatorning o'zi buzilib qolmasligini
// (soxta-yashil bo'lib ketmasligini) qo'riqlaydi.
// ─────────────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");

// Analizator: sys.argv[1] = fayl yo'li yoki "-" (stdin). JSON natija chiqaradi.
const PY_ANALYZER = `
import ast, json, sys

PERSIST = {"create_sale", "record_pul_olish", "pay_nasiya_fifo"}
GUARDS = {"_dokon_ruxsat_guard", "_savdo_dokon_ruxsat"}

def call_name(call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None

def terminates(stmts):
    """Statement ro'yxati shu yo'lda bajarilishni to'xtatadimi (return/raise)."""
    if not stmts:
        return False
    last = stmts[-1]
    if isinstance(last, (ast.Return, ast.Raise, ast.Continue, ast.Break)):
        return True
    if isinstance(last, ast.If):
        return bool(last.orelse) and terminates(last.body) and terminates(last.orelse)
    return False

def rejecting_guard(stmt):
    """\`if not GUARD(uid, <dokon>, ...): <body terminates>\` bo'lsa dokon-expr qaytaradi."""
    if not isinstance(stmt, ast.If):
        return None
    t = stmt.test
    if not (isinstance(t, ast.UnaryOp) and isinstance(t.op, ast.Not)):
        return None
    if not isinstance(t.operand, ast.Call):
        return None
    if call_name(t.operand) not in GUARDS:
        return None
    if len(t.operand.args) < 2:
        return None
    if not terminates(stmt.body):
        return None
    return ast.unparse(t.operand.args[1])

violations = []
persist_counts = {p: 0 for p in PERSIST}
guard_defined = False

def iter_calls_excluding_nested(node):
    stack = [node]
    while stack:
        cur = stack.pop()
        for child in ast.iter_child_nodes(cur):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            if isinstance(child, ast.Call):
                yield child
            stack.append(child)
    if isinstance(node, ast.Call):
        yield node

def check_stmt_exprs(stmt, guarded, fn_name, skip_bodies):
    """Statement'ning o'z ifodalarini tekshir (body'lar alohida rekursiyada)."""
    for field, value in ast.iter_fields(stmt):
        if field in skip_bodies:
            continue
        nodes = value if isinstance(value, list) else [value]
        for n in nodes:
            if isinstance(n, ast.AST):
                for c in iter_calls_excluding_nested(n):
                    if call_name(c) in PERSIST:
                        fn = call_name(c)
                        persist_counts[fn] += 1
                        if not c.args:
                            violations.append(f"{fn_name}: {fn} (line {c.lineno}) dokon argsiz")
                            continue
                        dokon = ast.unparse(c.args[0])
                        if dokon not in guarded:
                            violations.append(
                                f"{fn_name}: {fn} (line {c.lineno}) dokon={dokon} uchun dominatsiya qiluvchi guard yo'q"
                            )

BODY_FIELDS = {"body", "orelse", "finalbody", "handlers"}

def analyze_block(stmts, guarded, fn_name):
    guarded = set(guarded)
    for stmt in stmts:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            analyze_function(stmt)
            continue
        # statement'ning o'z ifodalari (if testi, assign qiymati, expr...)
        check_stmt_exprs(stmt, guarded, fn_name, BODY_FIELDS)
        g = rejecting_guard(stmt)
        if g is not None:
            # reject-branch ichida persist bo'lsa — hali himoyasiz kontekst
            analyze_block(stmt.body, guarded, fn_name)
            if stmt.orelse:
                analyze_block(stmt.orelse, guarded | {g}, fn_name)
            guarded.add(g)
            continue
        # ichki bloklar: guard branch ichida qolgani tashqariga chiqmaydi
        if isinstance(stmt, ast.If):
            analyze_block(stmt.body, guarded, fn_name)
            analyze_block(stmt.orelse, guarded, fn_name)
        elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
            analyze_block(stmt.body, guarded, fn_name)
            analyze_block(stmt.orelse, guarded, fn_name)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            analyze_block(stmt.body, guarded, fn_name)
        elif isinstance(stmt, ast.Try):
            analyze_block(stmt.body, guarded, fn_name)
            for h in stmt.handlers:
                analyze_block(h.body, guarded, fn_name)
            analyze_block(stmt.orelse, guarded, fn_name)
            analyze_block(stmt.finalbody, guarded, fn_name)

def analyze_function(fn):
    global guard_defined
    if fn.name in GUARDS:
        guard_defined = True
        return
    analyze_block(fn.body, set(), fn.name)

src = sys.stdin.read() if sys.argv[1] == "-" else open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(src)
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        analyze_function(node)

print(json.dumps({
    "violations": violations,
    "persist_counts": persist_counts,
    "guard_defined": guard_defined,
}))
`;

interface Result {
  violations: string[];
  persist_counts: Record<string, number>;
  guard_defined: boolean;
}

function analyzeFile(file: string): Result {
  const out = execFileSync("python3", ["-c", PY_ANALYZER, file], {
    cwd: botDir,
    stdio: "pipe",
  }).toString();
  return JSON.parse(out.trim());
}

function analyzeSource(source: string): Result {
  const out = execFileSync("python3", ["-c", PY_ANALYZER, "-"], {
    cwd: botDir,
    input: source,
    stdio: "pipe",
  }).toString();
  return JSON.parse(out.trim());
}

describe("distribution-bot AST guard — persist-oldi dokon ruxsat dominatsiyasi", () => {
  const result = analyzeFile("main.py");

  it("guard funksiyasi main.py da mavjud (nomi o'zgartirilsa test yangilansin)", () => {
    expect(result.guard_defined).toBe(true);
  });

  it("har bir create_sale/record_pul_olish/pay_nasiya_fifo chaqirig'ini o'sha dokon_id bilan rad etuvchi guard dominatsiya qiladi", () => {
    expect(result.violations, result.violations.join("; ")).toEqual([]);
  });

  it("persist chaqiriqlar haqiqatan topilgan (rename testni jim o'tkazib yubormasin)", () => {
    for (const fn of ["create_sale", "record_pul_olish", "pay_nasiya_fifo"]) {
      expect(result.persist_counts[fn], `${fn} chaqirig'i topilmadi`).toBeGreaterThan(0);
    }
  });
});

describe("analizatorning o'zi soxta-yashil emasligini mutation-fixture'lar qo'riqlaydi", () => {
  it("to'g'ri pattern (guard + o'sha dokon_id + early return) o'tadi", () => {
    const r = analyzeSource(
      [
        "def handler(uid, data):",
        "    user = get_user(uid)",
        "    if not _dokon_ruxsat_guard(uid, data['dokon_id'], user): return",
        "    create_sale(data['dokon_id'], uid, [], 0, 'naqd', None, 0)",
      ].join("\n"),
    );
    expect(r.violations).toEqual([]);
    expect(r.persist_counts["create_sale"]).toBe(1);
  });

  it("umuman guard'siz persist chaqiriq violation beradi", () => {
    const r = analyzeSource(
      ["def handler(uid, did):", "    record_pul_olish(did, uid, 1000)"].join("\n"),
    );
    expect(r.violations.length).toBe(1);
  });

  it("BOSHQA (unrelated) dokon_id bilan guard qilingan persist violation beradi", () => {
    const r = analyzeSource(
      [
        "def handler(uid, did, other_id):",
        "    if not _dokon_ruxsat_guard(uid, other_id): return",
        "    pay_nasiya_fifo(did, uid, 1000)",
      ].join("\n"),
    );
    expect(r.violations.length).toBe(1);
  });

  it("dominatsiya qilmaydigan branch ichidagi guard violation beradi", () => {
    const r = analyzeSource(
      [
        "def handler(uid, did, flag):",
        "    if flag:",
        "        if not _dokon_ruxsat_guard(uid, did): return",
        "    create_sale(did, uid, [], 0, 'naqd', None, 0)",
      ].join("\n"),
    );
    expect(r.violations.length).toBe(1);
  });

  it("return'siz guard-if (reject-branch to'xtamaydi) violation beradi", () => {
    const r = analyzeSource(
      [
        "def handler(uid, did):",
        "    if not _dokon_ruxsat_guard(uid, did):",
        "        log('rad')",
        "    record_pul_olish(did, uid, 1000)",
      ].join("\n"),
    );
    expect(r.violations.length).toBe(1);
  });

  it("nested funksiya ichidagi guard ota funksiyadagi persist'ni himoyalamaydi", () => {
    const r = analyzeSource(
      [
        "def handler(uid, did):",
        "    def inner():",
        "        if not _dokon_ruxsat_guard(uid, did): return",
        "    create_sale(did, uid, [], 0, 'naqd', None, 0)",
      ].join("\n"),
    );
    expect(r.violations.length).toBe(1);
  });

  it("reject-branch'ning ICHIDAGI persist chaqiriq ham violation beradi", () => {
    const r = analyzeSource(
      [
        "def handler(uid, did):",
        "    if not _dokon_ruxsat_guard(uid, did):",
        "        record_pul_olish(did, uid, 1000)",
        "        return",
        "    return",
      ].join("\n"),
    );
    expect(r.violations.length).toBe(1);
  });
});
