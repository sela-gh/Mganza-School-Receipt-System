import { useEffect, useMemo, useState, useRef } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { supabase } from "@/lib/supabase";

// ─── Types ─────────────────────────────────────────────────────────────────────
type Stream =
  | "PP1" | "PP2"
  | "Class 1" | "Class 2" | "Class 3" | "Class 4" | "Class 5" | "Class 6" | "Class 7";

const STREAMS: Stream[] = [
  "PP1", "PP2",
  "Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6", "Class 7",
];

// term_fees JSONB shape stored in classes table:
// {
//   "1_base": 15000,       ← Term 1, day student (no transport)
//   "1_transport": 22000,  ← Term 1, day student WITH school transport
//   "2_base": 15000,
//   "2_transport": 22000,
// }
type TermFeeMap = Record<Stream, number>;       // base fees for current term
type TermFeeTransportMap = Record<Stream, number>; // transport fees for current term

type Student = {
  id:            string;
  name:          string;
  stream:        Stream;
  guardian?:     string;
  usesTransport: boolean;   // NEW — drives which fee bucket applies
  expectedFees:  number;
};

type PaymentMethod = "Bank Transfer" | "Cash";

type Transaction = {
  id:         string;
  date:       string;
  studentId:  string;
  amount:     number;
  method:     PaymentMethod;
  reference?: string;
  receivedBy: string;
  notes?:     string;
};

type Unallocated = {
  id:             string;
  date:           string;
  amount:         number;
  method:         PaymentMethod;
  reference?:     string;
  depositorName?: string;
  reason:         string;
};

// ─── DB row types ──────────────────────────────────────────────────────────────
type StudentRow = {
  id:               string;
  full_name:        string;
  class_id:         string;
  guardian:         string | null;
  uses_transport:   boolean;          // NEW column on students table
  classes:          { name: string; term_fees: Record<string, number> | null } |
                    { name: string; term_fees: Record<string, number> | null }[] | null;
  student_term_fees: Array<{ expected_fee: number; term_id?: string }> | null;
};

type TransactionRow = {
  id:           string;
  payment_date: string;
  student_id:   string;
  amount:       number;
  method:       PaymentMethod;
  reference:    string | null;
  received_by:  string;
  notes:        string | null;
};

type UnallocatedRow = {
  id:             string;
  deposit_date:   string;
  amount:         number;
  method:         PaymentMethod;
  reference:      string | null;
  depositor_name: string | null;
  reason:         string;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("en-TZ", { style: "currency", currency: "TZS", maximumFractionDigits: 0 }).format(n);

const EMPTY_FEES: TermFeeMap = STREAMS.reduce((acc, s) => { acc[s] = 0; return acc; }, {} as TermFeeMap);

// Given a class's term_fees jsonb and the current term number,
// return {base, transport} fees. Falls back to 0 if key missing.
function extractFees(
  termFees: Record<string, number> | null | undefined,
  termNumber: number,
): { base: number; transport: number } {
  if (!termFees) return { base: 0, transport: 0 };
  return {
    base:      Number(termFees[`${termNumber}_base`]      ?? termFees[String(termNumber)] ?? 0),
    transport: Number(termFees[`${termNumber}_transport`] ?? 0),
  };
}

// ─── Term helpers ─────────────────────────────────────────────────────────────
type TermLabel = { number: 1 | 2; year: number; label: string; start: string; end: string };

function getCurrentTerm(): TermLabel {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  if (month >= 1 && month <= 6)
    return { number: 1, year, label: `Term 1 · ${year}`, start: `${year}-01-01`, end: `${year}-06-30` };
  return { number: 2, year, label: `Term 2 · ${year}`, start: `${year}-07-01`, end: `${year}-11-30` };
}

const CURRENT_TERM = getCurrentTerm();

// Map a StudentRow → Student UI type
const studentFromRow = (r: StudentRow, termKey?: string): Student => {
  const classesObj  = Array.isArray(r.classes) ? r.classes[0] : r.classes;
  const termNumber  = Number(termKey ?? String(CURRENT_TERM.number));
  const { base, transport } = extractFees(classesObj?.term_fees, termNumber);
  const usesTransport = r.uses_transport ?? false;

  // student_term_fees is the per-student override (e.g. bursaries)
  const stfFee      = r.student_term_fees?.[0]?.expected_fee;
  // If no override, pick the right bucket (base vs transport)
  const expectedFees = stfFee != null ? stfFee : (usesTransport ? transport : base);

  return {
    id:            r.id,
    name:          r.full_name,
    stream:        (classesObj?.name ?? "") as Stream,
    guardian:      r.guardian ?? undefined,
    usesTransport,
    expectedFees,
  };
};

const txFromRow        = (r: TransactionRow): Transaction => ({
  id: r.id, date: r.payment_date, studentId: r.student_id, amount: r.amount,
  method: r.method, reference: r.reference ?? undefined,
  receivedBy: r.received_by, notes: r.notes ?? undefined,
});
const unallocFromRow   = (r: UnallocatedRow): Unallocated => ({
  id: r.id, date: r.deposit_date, amount: r.amount, method: r.method,
  reference: r.reference ?? undefined, depositorName: r.depositor_name ?? undefined, reason: r.reason,
});

type Page = "overview" | "transactions" | "unallocated" | { type: "class"; stream: Stream };

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════════
export default function Dashboard() {
  const [termFees,          setTermFees]          = useState<TermFeeMap>(EMPTY_FEES);
  const [termFeesTransport, setTermFeesTransport] = useState<TermFeeTransportMap>(EMPTY_FEES);
  const [students,          setStudents]          = useState<Student[]>([]);
  const [transactions,      setTransactions]      = useState<Transaction[]>([]);
  const [unallocated,       setUnallocated]       = useState<Unallocated[]>([]);
  const [loading,           setLoading]           = useState(true);
  const [page,              setPage]              = useState<Page>("overview");
  const [receiptTx,         setReceiptTx]         = useState<Transaction | null>(null);
  const [sidebarOpen,       setSidebarOpen]       = useState(false);

  // ── Load ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: termData } = await supabase
          .from("terms")
          .select("id, term_number, year")
          .eq("term_number", CURRENT_TERM.number)
          .eq("year", CURRENT_TERM.year)
          .maybeSingle();
        const termId: string | null = (termData as { id: string } | null)?.id ?? null;

        const [classesRes, studentsRes, txsRes, unallocRes] = await Promise.all([
          supabase.from("classes").select("id, name, term_fees").order("sort_order"),
          supabase
            .from("students")
            // NEW: select uses_transport
            .select("id, full_name, class_id, guardian, uses_transport, classes(name, term_fees), student_term_fees(expected_fee, term_id)")
            .eq("is_active", true)
            .order("full_name"),
          supabase
            .from("transactions")
            .select("id, payment_date, student_id, amount, method, reference, received_by, notes")
            .gte("payment_date", CURRENT_TERM.start)
            .lte("payment_date", CURRENT_TERM.end)
            .order("payment_date", { ascending: false }),
          supabase
            .from("unallocated_funds")
            .select("id, deposit_date, amount, method, reference, depositor_name, reason")
            .eq("resolved", false)
            .order("deposit_date", { ascending: false }),
        ]);

        if (cancelled) return;
        if (classesRes.error)  throw classesRes.error;
        if (studentsRes.error) throw studentsRes.error;
        if (txsRes.error)      throw txsRes.error;
        if (unallocRes.error)  throw unallocRes.error;

        // Build both fee maps from classes.term_fees jsonb
        if (classesRes.data) {
          const baseFees:      TermFeeMap = { ...EMPTY_FEES };
          const transportFees: TermFeeMap = { ...EMPTY_FEES };
          for (const row of classesRes.data as Array<{ id: string; name: string; term_fees: Record<string, number> | null }>) {
            if ((STREAMS as string[]).includes(row.name)) {
              const { base, transport } = extractFees(row.term_fees, CURRENT_TERM.number);
              baseFees[row.name as Stream]      = base;
              transportFees[row.name as Stream] = transport;
            }
          }
          setTermFees(baseFees);
          setTermFeesTransport(transportFees);
        }

        const termKey     = String(CURRENT_TERM.number);
        const rawStudents = (studentsRes.data ?? []) as Array<StudentRow & {
          student_term_fees: Array<{ expected_fee: number; term_id?: string }> | null;
        }>;
        const filteredStudents = rawStudents.map(s => ({
          ...s,
          student_term_fees: termId
            ? (s.student_term_fees ?? []).filter(f => f.term_id === termId)
            : (s.student_term_fees ?? []),
        }));
        setStudents(filteredStudents.map(s => studentFromRow(s as StudentRow, termKey)));
        setTransactions((txsRes.data ?? []).map(r => txFromRow(r as TransactionRow)));
        setUnallocated((unallocRes.data ?? []).map(r => unallocFromRow(r as UnallocatedRow)));
      } catch (err) {
        console.error(err);
        toast.error("Failed to load data. Please refresh.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const studentLookup = useMemo(() => Object.fromEntries(students.map(s => [s.id, s])), [students]);

  const totals = useMemo(() => {
    const expected  = students.reduce((a, s) => a + s.expectedFees, 0);
    const collected = transactions.reduce((a, t) => a + t.amount, 0);
    return { expected, collected, debt: Math.max(0, expected - collected), unallocatedAmt: unallocated.reduce((a, u) => a + u.amount, 0) };
  }, [students, transactions, unallocated]);

  const streamStats = useMemo(() => STREAMS.map(stream => {
    const ss  = students.filter(s => s.stream === stream);
    const exp = ss.reduce((a, s) => a + s.expectedFees, 0);
    const col = transactions.filter(t => ss.some(s => s.id === t.studentId)).reduce((a, t) => a + t.amount, 0);
    return { stream, count: ss.length, expected: exp, collected: col, debt: Math.max(0, exp - col) };
  }), [students, transactions]);

  // ── Mutators ─────────────────────────────────────────────────────────────────

  // addStudents: now receives usesTransport per student
  const addStudents = async (
    newStudents: Array<Omit<Student, "id" | "expectedFees">>
  ) => {
    if (newStudents.length === 0) return;

    const streamSet = [...new Set(newStudents.map(s => s.stream))];
    const { data: classRows, error: classErr } = await supabase
      .from("classes").select("id, name, term_fees").in("name", streamSet);
    if (classErr) { toast.error(classErr.message); return; }

    const classMap = Object.fromEntries(
      (classRows ?? []).map((r: { id: string; name: string; term_fees: Record<string, number> | null }) => [r.name, r])
    );

    const insertRows = newStudents.map(s => {
      const cls = classMap[s.stream];
      if (!cls) throw new Error(`Class "${s.stream}" not found`);
      return {
        full_name:      s.name,
        class_id:       cls.id,
        guardian:       s.guardian ?? null,
        uses_transport: s.usesTransport,   // NEW column
      };
    });

    const { data, error } = await supabase
      .from("students")
      .insert(insertRows)
      .select("id, full_name, class_id, guardian, uses_transport, classes(name, term_fees), student_term_fees(expected_fee, term_id)");
    if (error) { toast.error(error.message); return; }

    const termKey = String(CURRENT_TERM.number);
    const added   = (data ?? []).map(r => studentFromRow(r as unknown as StudentRow, termKey));
    setStudents(p => [...p, ...added]);
    toast.success(added.length === 1 ? `${added[0].name} enrolled` : `${added.length} students enrolled`);
  };

  const editStudent = async (s: Student) => {
    const { data: classRow, error: classErr } = await supabase
      .from("classes").select("id").eq("name", s.stream).maybeSingle();
    if (classErr) { toast.error(classErr.message); return; }
    if (!classRow) { toast.error(`Class "${s.stream}" not found`); return; }

    const { data, error } = await supabase
      .from("students")
      .update({ full_name: s.name, class_id: classRow.id, guardian: s.guardian ?? null, uses_transport: s.usesTransport })
      .eq("id", s.id)
      .select("id, full_name, class_id, guardian, uses_transport, classes(name, term_fees), student_term_fees(expected_fee, term_id)")
      .single();
    if (error) { toast.error(error.message); return; }
    setStudents(p => p.map(x => x.id === s.id ? studentFromRow(data as unknown as StudentRow, String(CURRENT_TERM.number)) : x));
    toast.success("Student updated");
  };

  const removeStudent = async (id: string) => {
    const { error } = await supabase.from("students").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    setStudents(p => p.filter(s => s.id !== id));
    toast.success("Student removed");
  };

  const moveStudent = async (id: string, to: Stream) => {
    const { data: classRow, error: classErr } = await supabase
      .from("classes").select("id").eq("name", to).maybeSingle();
    if (classErr) { toast.error(classErr.message); return; }
    if (!classRow) { toast.error(`Class "${to}" not found`); return; }
    const { data, error } = await supabase
      .from("students")
      .update({ class_id: classRow.id })
      .eq("id", id)
      .select("id, full_name, class_id, guardian, uses_transport, classes(name, term_fees), student_term_fees(expected_fee, term_id)")
      .single();
    if (error) { toast.error(error.message); return; }
    setStudents(p => p.map(s => s.id === id ? studentFromRow(data as unknown as StudentRow, String(CURRENT_TERM.number)) : s));
    toast.success("Student moved to " + to);
  };

  // updateFee now receives which bucket (base | transport) is being changed
  const updateFee = async (stream: Stream, bucket: "base" | "transport", amt: number) => {
    const { data: classRow, error: fetchErr } = await supabase
      .from("classes").select("id, term_fees").eq("name", stream).maybeSingle();
    if (fetchErr) { toast.error(fetchErr.message); return; }
    if (!classRow) { toast.error(`Class "${stream}" not found`); return; }

    const { data: activeTerm } = await supabase
      .from("terms").select("id").eq("term_number", CURRENT_TERM.number).eq("year", CURRENT_TERM.year).maybeSingle();
    const termId: string | null = (activeTerm as { id: string } | null)?.id ?? null;

    // Update the correct key in the JSONB object
    const currentFees = (classRow.term_fees ?? {}) as Record<string, number>;
    const feeKey      = `${CURRENT_TERM.number}_${bucket}`;
    const newTermFees = { ...currentFees, [feeKey]: amt };

    const { error: updErr } = await supabase
      .from("classes").update({ term_fees: newTermFees }).eq("id", (classRow as { id: string }).id);
    if (updErr) { toast.error(updErr.message); return; }

    // Cascade to student_term_fees for students in this class whose bucket matches
    if (termId) {
      const { data: classStudents } = await supabase
        .from("students").select("id, uses_transport").eq("class_id", (classRow as { id: string }).id).eq("is_active", true);
      const targetStudents = (classStudents ?? []).filter(
        (r: { id: string; uses_transport: boolean }) =>
          (bucket === "transport") === r.uses_transport
      );
      const studentIds = targetStudents.map((r: { id: string }) => r.id);
      if (studentIds.length > 0) {
        await supabase
          .from("student_term_fees")
          .update({ expected_fee: amt })
          .in("student_id", studentIds)
          .eq("term_id", termId);
      }
    }

    // Update local state
    if (bucket === "base") {
      setTermFees(p => ({ ...p, [stream]: amt }));
      setStudents(p => p.map(s => s.stream === stream && !s.usesTransport ? { ...s, expectedFees: amt } : s));
    } else {
      setTermFeesTransport(p => ({ ...p, [stream]: amt }));
      setStudents(p => p.map(s => s.stream === stream && s.usesTransport ? { ...s, expectedFees: amt } : s));
    }
    toast.success(`${stream} ${bucket === "base" ? "day" : "transport"} fee updated`);
  };

  const recordTx = async (t: Omit<Transaction, "id">) => {
    const { data, error } = await supabase
      .from("transactions")
      .insert({ payment_date: t.date, student_id: t.studentId, amount: t.amount, method: t.method, reference: t.reference ?? null, received_by: t.receivedBy, notes: t.notes ?? null })
      .select("id, payment_date, student_id, amount, method, reference, received_by, notes")
      .single();
    if (error) { toast.error(error.message); return; }
    const tx = txFromRow(data as TransactionRow);
    setTransactions(p => [tx, ...p]);
    setReceiptTx(tx);
    toast.success("Payment recorded");
  };

  const addUnallocated = async (u: Omit<Unallocated, "id">) => {
    const { data, error } = await supabase
      .from("unallocated_funds")
      .insert({ deposit_date: u.date, amount: u.amount, method: u.method, reference: u.reference ?? null, depositor_name: u.depositorName ?? null, reason: u.reason, resolved: false })
      .select("id, deposit_date, amount, method, reference, depositor_name, reason")
      .single();
    if (error) { toast.error(error.message); return; }
    setUnallocated(p => [unallocFromRow(data as UnallocatedRow), ...p]);
    toast.success("Entry logged");
  };

  const allocateUnallocated = async (entryId: string, studentId: string) => {
    const u = unallocated.find(x => x.id === entryId);
    if (!u) return;
    const { data: txData, error: txErr } = await supabase
      .from("transactions")
      .insert({ payment_date: u.date, student_id: studentId, amount: u.amount, method: u.method, reference: u.reference ?? null, received_by: "Reallocated", notes: `Allocated from unallocated_funds ${u.id}` })
      .select("id, payment_date, student_id, amount, method, reference, received_by, notes")
      .single();
    if (txErr) { toast.error(txErr.message); return; }
    const { error: resolveErr } = await supabase
      .from("unallocated_funds").update({ resolved: true, resolved_tx_id: txData.id }).eq("id", entryId);
    if (resolveErr) { toast.error(resolveErr.message); return; }
    const tx = txFromRow(txData as TransactionRow);
    setTransactions(p => [tx, ...p]);
    setUnallocated(p => p.filter(x => x.id !== entryId));
    setReceiptTx(tx);
    toast.success("Funds allocated");
  };

  const activeStream   = typeof page === "object" ? page.stream : null;
  const activeStudents = activeStream ? students.filter(s => s.stream === activeStream) : [];

  return (
    <div className="app-shell">
      <Toaster richColors position="top-right" />
      {receiptTx && (
        <ReceiptModal tx={receiptTx} student={studentLookup[receiptTx.studentId]} onClose={() => setReceiptTx(null)} />
      )}

      {/* Mobile header */}
      <div className="mobile-header">
        <button className="burger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
          <span /><span /><span />
        </button>
        <span className="mobile-title">Madam Paradise</span>
        <RecordTxBtn students={students} onRecord={recordTx} />
      </div>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-icon">MP</div>
          <div>
            <div className="brand-name">Madam Paradise</div>
            <div className="brand-sub">Fees Management</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          <div className="nav-section-label">Main</div>
          <NavItem icon="⊞" label="Overview" active={page === "overview"} onClick={() => { setPage("overview"); setSidebarOpen(false); }} />
          <NavItem icon="↔" label="Transactions" active={page === "transactions"} badge={transactions.length} onClick={() => { setPage("transactions"); setSidebarOpen(false); }} />
          <NavItem icon="◎" label="Unallocated" active={page === "unallocated"} badge={unallocated.length > 0 ? unallocated.length : undefined} badgeAlert onClick={() => { setPage("unallocated"); setSidebarOpen(false); }} />
          <div className="nav-section-label" style={{ marginTop: "1.5rem" }}>Classes</div>
          {STREAMS.map(stream => {
            const st = streamStats.find(s => s.stream === stream)!;
            return (
              <NavItem key={stream} icon="▸" label={stream} active={typeof page === "object" && page.stream === stream} sub={`${st.count} students`}
                onClick={() => { setPage({ type: "class", stream }); setSidebarOpen(false); }} />
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="term-pill">{CURRENT_TERM.label}</div>
        </div>
      </aside>

      {/* Main area */}
      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            {page === "overview"     && "Overview"}
            {page === "transactions" && "Transactions"}
            {page === "unallocated"  && "Unallocated Funds"}
            {typeof page === "object" && (
              <span className="flex items-center gap-2">
                <button className="back-btn" onClick={() => setPage("overview")}>← Back</button>
                {page.stream} — Class Register
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <RecordTxBtn students={students} onRecord={recordTx} />
          </div>
        </header>

        <main className="page-content">
          {loading && (
            <div className="empty-row" style={{ padding: "3rem", textAlign: "center" }}>Loading…</div>
          )}

          {/* OVERVIEW */}
          {!loading && page === "overview" && (
            <div className="fade-in">
              <div className="stat-grid">
                <StatCard label="Expected Revenue"  value={fmt(totals.expected)}      hint={`${students.length} students`} />
                <StatCard label="Total Collected"   value={fmt(totals.collected)}      accent="success" hint={`${Math.round((totals.collected / (totals.expected || 1)) * 100)}% collected`} />
                <StatCard label="Outstanding Debt"  value={fmt(totals.debt)}           accent="danger" />
                <StatCard label="Unallocated Funds" value={fmt(totals.unallocatedAmt)} accent="warn" hint={`${unallocated.length} pending`} />
              </div>
              <div className="section-head">
                <h2 className="section-title">Classes</h2>
                <EditFeesModal termFees={termFees} termFeesTransport={termFeesTransport} onUpdate={updateFee} />
              </div>
              <div className="class-grid">
                {streamStats.map(row => {
                  const pct = row.expected ? Math.round((row.collected / row.expected) * 100) : 0;
                  return (
                    <button key={row.stream} className="class-card" onClick={() => setPage({ type: "class", stream: row.stream })}>
                      <div className="class-card-head">
                        <span className="class-name">{row.stream}</span>
                        <span className="class-count">{row.count} pupils</span>
                      </div>
                      <div className="class-fee-label">Day {fmt(termFees[row.stream])} · Transport {fmt(termFeesTransport[row.stream])}</div>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="class-card-foot">
                        <span className="c-success">{fmt(row.collected)} collected</span>
                        <span className="c-danger">{fmt(row.debt)} owed</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* CLASS DETAIL */}
          {!loading && typeof page === "object" && (() => {
            const stream     = page.stream;
            const stats      = streamStats.find(s => s.stream === stream)!;
            const classStudents = students.filter(s => s.stream === stream).map(s => {
              const paid    = transactions.filter(t => t.studentId === s.id).reduce((a, t) => a + t.amount, 0);
              const balance = s.expectedFees - paid;
              const status: "cleared" | "partial" | "unpaid" | "overpaid" =
                s.expectedFees > 0 && paid >= s.expectedFees ? "cleared"
                : balance < 0 ? "overpaid"
                : paid > 0   ? "partial"
                : "unpaid";
              return { ...s, paid, balance, status };
            });
            const classTxs = transactions.filter(t => activeStudents.some(s => s.id === t.studentId));

            return (
              <div className="fade-in">
                <div className="stat-grid">
                  <StatCard label="Enrolled"    value={String(stats.count)} hint={`Day ${fmt(termFees[stream])} · Transport ${fmt(termFeesTransport[stream])}`} />
                  <StatCard label="Expected"    value={fmt(stats.expected)} />
                  <StatCard label="Collected"   value={fmt(stats.collected)} accent="success" hint={`${Math.round((stats.collected / (stats.expected || 1)) * 100)}%`} />
                  <StatCard label="Outstanding" value={fmt(stats.debt)} accent="danger" />
                </div>

                <div className="section-head">
                  <h2 className="section-title">Students — {stream}</h2>
                  <BulkAddStudentModal defaultStream={stream} onAdd={addStudents} />
                </div>

                <div className="table-card">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Name</th><th>Guardian</th>
                        <th>Type</th>
                        <th className="num">Expected</th>
                        <th className="num">Paid</th>
                        <th className="num">Balance</th>
                        <th>Status</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {classStudents.map((s, i) => (
                        <tr key={s.id}>
                          <td className="row-num">{i + 1}</td>
                          <td className="name-cell">{s.name}</td>
                          <td className="muted-cell">{s.guardian ?? "—"}</td>
                          <td>
                            <span className={`transport-badge transport-badge--${s.usesTransport ? "yes" : "no"}`}>
                              {s.usesTransport ? "🚌 Transport" : "🚶 Day"}
                            </span>
                          </td>
                          <td className="num">{fmt(s.expectedFees)}</td>
                          <td className="num">{fmt(s.paid)}</td>
                          <td className="num">
                            {s.balance > 0 ? <span className="c-danger">{fmt(s.balance)}</span>
                             : s.balance < 0 ? <span className="c-warn">Overpaid {fmt(Math.abs(s.balance))}</span>
                             : <span className="c-success">{fmt(0)}</span>}
                          </td>
                          <td><StatusBadge status={s.status} /></td>
                          <td>
                            <div className="row-actions">
                              <EditStudentModal student={s} onSave={editStudent} />
                              <MoveStudentModal student={s} currentStream={stream} onMove={to => moveStudent(s.id, to)} />
                              <button className="action-btn danger" onClick={() => { if (confirm(`Remove ${s.name}?`)) removeStudent(s.id); }}>Remove</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {classStudents.length === 0 && (
                        <tr><td colSpan={9} className="empty-row">No students enrolled in {stream} yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="section-head" style={{ marginTop: "2rem" }}>
                  <h2 className="section-title">Payment History</h2>
                </div>
                <div className="table-card">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th><th>Student</th><th>Method</th>
                        <th>Reference</th><th>Received By</th>
                        <th className="num">Amount</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {classTxs.map(t => {
                        const st = studentLookup[t.studentId];
                        return (
                          <tr key={t.id}>
                            <td className="mono-cell">{t.date}</td>
                            <td className="name-cell">{st?.name ?? "—"}</td>
                            <td><MethodBadge method={t.method} /></td>
                            <td className="mono-cell">{t.reference ?? "—"}</td>
                            <td className="muted-cell">{t.receivedBy}</td>
                            <td className="num bold-cell">{fmt(t.amount)}</td>
                            <td><button className="action-btn" onClick={() => setReceiptTx(t)}>Receipt</button></td>
                          </tr>
                        );
                      })}
                      {classTxs.length === 0 && (
                        <tr><td colSpan={7} className="empty-row">No payments recorded for {stream}.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* TRANSACTIONS */}
          {!loading && page === "transactions" && (
            <TransactionsPage transactions={transactions} studentLookup={studentLookup} onViewReceipt={setReceiptTx} students={students} onRecord={recordTx} />
          )}

          {/* UNALLOCATED */}
          {!loading && page === "unallocated" && (
            <UnallocatedPage entries={unallocated} students={students} onAdd={addUnallocated} onAllocate={allocateUnallocated} />
          )}
        </main>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS PAGE (unchanged from original)
// ═══════════════════════════════════════════════════════════════════════════════
function TransactionsPage({ transactions, studentLookup, onViewReceipt }: {
  transactions: Transaction[]; studentLookup: Record<string, Student>;
  onViewReceipt: (t: Transaction) => void; students: Student[]; onRecord: (t: Omit<Transaction, "id">) => void;
}) {
  const [search, setSearch]   = useState("");
  const [streamF, setStreamF] = useState<"all" | Stream>("all");
  const [methodF, setMethodF] = useState<"all" | PaymentMethod>("all");
  const [from, setFrom]       = useState("");
  const [to, setTo]           = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter(t => {
      const st = studentLookup[t.studentId];
      if (streamF !== "all" && st?.stream !== streamF) return false;
      if (methodF !== "all" && t.method !== methodF)   return false;
      if (from && t.date < from)                       return false;
      if (to   && t.date > to)                         return false;
      if (q) {
        const hay = [st?.name, st?.stream, t.reference, t.receivedBy, t.notes].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [transactions, studentLookup, search, streamF, methodF, from, to]);

  const total = useMemo(() => filtered.reduce((a, t) => a + t.amount, 0), [filtered]);

  return (
    <div className="fade-in">
      <div className="filter-bar">
        <input className="filter-input filter-search" placeholder="Search student, reference…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="filter-select" value={streamF} onChange={e => setStreamF(e.target.value as "all" | Stream)}>
          <option value="all">All streams</option>
          {STREAMS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="filter-select" value={methodF} onChange={e => setMethodF(e.target.value as "all" | PaymentMethod)}>
          <option value="all">All methods</option>
          <option value="Bank Transfer">Bank Transfer</option>
          <option value="Cash">Cash</option>
        </select>
        <input className="filter-input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <input className="filter-input" type="date" value={to}   onChange={e => setTo(e.target.value)} />
        {(search || streamF !== "all" || methodF !== "all" || from || to) && (
          <button className="action-btn" onClick={() => { setSearch(""); setStreamF("all"); setMethodF("all"); setFrom(""); setTo(""); }}>Clear</button>
        )}
      </div>
      <div className="filter-meta">
        <span>{filtered.length} of {transactions.length} transactions · Total <strong>{fmt(total)}</strong></span>
      </div>
      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th><th>Student</th><th>Stream</th><th>Method</th>
              <th>Reference</th><th>Received By</th>
              <th className="num">Amount</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => {
              const st = studentLookup[t.studentId];
              return (
                <tr key={t.id}>
                  <td className="mono-cell">{t.date}</td>
                  <td className="name-cell">{st?.name ?? "—"}</td>
                  <td>{st?.stream ?? "—"}</td>
                  <td><MethodBadge method={t.method} /></td>
                  <td className="mono-cell">{t.reference ?? "—"}</td>
                  <td className="muted-cell">{t.receivedBy}</td>
                  <td className="num bold-cell">{fmt(t.amount)}</td>
                  <td><button className="action-btn" onClick={() => onViewReceipt(t)}>Receipt</button></td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={8} className="empty-row">No transactions match the filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNALLOCATED PAGE (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════
function UnallocatedPage({ entries, students, onAdd, onAllocate }: {
  entries: Unallocated[]; students: Student[];
  onAdd: (u: Omit<Unallocated, "id">) => void; onAllocate: (uid: string, studentId: string) => void;
}) {
  const [showForm, setShowForm]         = useState(false);
  const [amount, setAmount]             = useState("");
  const [method, setMethod]             = useState<PaymentMethod>("Bank Transfer");
  const [reference, setReference]       = useState("");
  const [depositorName, setDepositorName] = useState("");
  const [reason, setReason]             = useState("");
  const [date, setDate]                 = useState(new Date().toISOString().slice(0, 10));

  const submitNew = () => {
    const amt = Number(amount);
    if (!amt || !reason) { toast.error("Amount and reason are required"); return; }
    onAdd({ date, amount: amt, method, reference: reference || undefined, depositorName: depositorName || undefined, reason });
    setShowForm(false);
    setAmount(""); setReference(""); setDepositorName(""); setReason("");
  };

  return (
    <div className="fade-in">
      <div className="section-head">
        <p className="section-desc">Deposits that couldn't be matched to a student. Allocate once verified.</p>
        <button className="btn-primary" onClick={() => setShowForm(s => !s)}>{showForm ? "Cancel" : "+ Log Entry"}</button>
      </div>
      {showForm && (
        <div className="form-card">
          <div className="form-grid">
            <div className="form-field"><label>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
            <div className="form-field"><label>Amount (TZS)</label><input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} /></div>
            <div className="form-field"><label>Method</label>
              <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
                <option value="Bank Transfer">Bank Transfer</option><option value="Cash">Cash</option>
              </select>
            </div>
            <div className="form-field"><label>Reference / Slip</label><input value={reference} onChange={e => setReference(e.target.value)} /></div>
            <div className="form-field"><label>Depositor Name (if known)</label><input value={depositorName} onChange={e => setDepositorName(e.target.value)} /></div>
            <div className="form-field form-field--full"><label>Reason <span className="required">*</span></label>
              <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why can't this be allocated?" />
            </div>
          </div>
          <div className="form-actions">
            <button className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn-primary" onClick={submitNew}>Save Entry</button>
          </div>
        </div>
      )}
      <div className="table-card">
        <table className="data-table">
          <thead><tr><th>Date</th><th>Depositor</th><th>Method</th><th>Reference</th><th>Reason</th><th className="num">Amount</th><th></th></tr></thead>
          <tbody>
            {entries.map(u => (
              <tr key={u.id}>
                <td className="mono-cell">{u.date}</td>
                <td className="name-cell">{u.depositorName ?? "Unknown"}</td>
                <td><MethodBadge method={u.method} /></td>
                <td className="mono-cell">{u.reference ?? "—"}</td>
                <td className="muted-cell">{u.reason}</td>
                <td className="num bold-cell">{fmt(u.amount)}</td>
                <td><AllocateInline entryId={u.id} students={students} onAllocate={sid => onAllocate(u.id, sid)} /></td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={7} className="empty-row">No unallocated funds. All good!</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMALL UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════
function NavItem({ icon, label, active, badge, badgeAlert, sub, onClick }: {
  icon: string; label: string; active: boolean; badge?: number; badgeAlert?: boolean; sub?: string; onClick: () => void;
}) {
  return (
    <button className={`nav-item${active ? " nav-item--active" : ""}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}{sub && <span className="nav-sub">{sub}</span>}</span>
      {badge !== undefined && <span className={`nav-badge${badgeAlert ? " nav-badge--alert" : ""}`}>{badge}</span>}
    </button>
  );
}

function StatCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: "success" | "danger" | "warn" }) {
  return (
    <div className={`stat-card${accent ? ` stat-card--${accent}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: "cleared" | "partial" | "unpaid" | "overpaid" }) {
  return <span className={`status-badge status-badge--${status}`}>{status === "overpaid" ? "overpaid ↑" : status}</span>;
}

function MethodBadge({ method }: { method: PaymentMethod }) {
  return <span className={`method-badge method-badge--${method === "Cash" ? "cash" : "bank"}`}>{method}</span>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORD TRANSACTION (unchanged — class-first two-step picker)
// ═══════════════════════════════════════════════════════════════════════════════
function RecordTxBtn({ students, onRecord }: { students: Student[]; onRecord: (t: Omit<Transaction, "id">) => void }) {
  const [open, setOpen]                         = useState(false);
  const [selectedStream, setSelectedStream]     = useState<Stream | "">("");
  const [studentId, setStudentId]               = useState("");
  const [studentSearch, setStudentSearch]       = useState("");
  const [amount, setAmount]                     = useState("");
  const [method, setMethod]                     = useState<PaymentMethod>("Cash");
  const [reference, setReference]               = useState("");
  const [receivedBy, setReceivedBy]             = useState("Bursar");
  const [date, setDate]                         = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes]                       = useState("");

  const streamStudents = useMemo(() => {
    if (!selectedStream) return [];
    const base = students.filter(s => s.stream === selectedStream);
    const q    = studentSearch.trim().toLowerCase();
    return q ? base.filter(s => s.name.toLowerCase().includes(q)) : base;
  }, [students, selectedStream, studentSearch]);

  const pickedStudent = students.find(s => s.id === studentId);

  const reset = () => {
    setSelectedStream(""); setStudentId(""); setStudentSearch(""); setAmount("");
    setReference(""); setNotes(""); setMethod("Cash"); setReceivedBy("Bursar");
    setDate(new Date().toISOString().slice(0, 10));
  };
  const close  = () => { setOpen(false); reset(); };
  const submit = () => {
    const amt = Number(amount);
    if (!studentId)       { toast.error("Select a student"); return; }
    if (!amt || amt <= 0) { toast.error("Enter a valid amount"); return; }
    onRecord({ date, studentId, amount: amt, method, reference: reference || undefined, receivedBy, notes: notes || undefined });
    close();
  };

  return (
    <>
      <button className="btn-primary btn-record" onClick={() => setOpen(true)}>+ Record Payment</button>
      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Record Fee Payment</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>

            {/* Step 1 — class */}
            <div className="step-block">
              <div className="step-label"><span className="step-num">1</span> Select Class</div>
              <div className="stream-picker">
                {STREAMS.map(s => (
                  <button key={s} className={`stream-chip${selectedStream === s ? " stream-chip--active" : ""}`}
                    onClick={() => { setSelectedStream(s); setStudentId(""); setStudentSearch(""); }}>
                    {s}
                    <span className="chip-count">{students.filter(st => st.stream === s).length}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2 — student */}
            {selectedStream && (
              <div className="step-block">
                <div className="step-label"><span className="step-num">2</span> Select Student — {selectedStream}</div>
                <input className="student-search" placeholder="Type to filter by name…" value={studentSearch}
                  onChange={e => { setStudentSearch(e.target.value); setStudentId(""); }} autoFocus />
                <div className="student-list">
                  {streamStudents.length === 0 && (
                    <div className="student-list-empty">
                      {studentSearch ? "No students match that name." : "No students in this class yet."}
                    </div>
                  )}
                  {streamStudents.map(s => (
                    <button key={s.id} className={`student-row${studentId === s.id ? " student-row--active" : ""}`}
                      onClick={() => setStudentId(s.id)}>
                      <span className="student-row-name">{s.name}</span>
                      <span className="student-row-meta">
                        {s.usesTransport ? "🚌 Transport" : "🚶 Day"}{s.guardian ? ` · Guardian: ${s.guardian}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Step 3 — payment details */}
            {studentId && (
              <div className="step-block">
                <div className="step-label">
                  <span className="step-num">3</span> Payment Details
                  {pickedStudent && <span className="step-label-hint">for {pickedStudent.name} · Outstanding {fmt(Math.max(0, pickedStudent.expectedFees - 0))}</span>}
                </div>
                <div className="form-grid">
                  <div className="form-field"><label>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
                  <div className="form-field"><label>Amount (TZS) <span className="required">*</span></label>
                    <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" /></div>
                  <div className="form-field"><label>Method</label>
                    <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
                      <option value="Cash">Cash</option><option value="Bank Transfer">Bank Transfer</option>
                    </select>
                  </div>
                  <div className="form-field"><label>Received By</label><input value={receivedBy} onChange={e => setReceivedBy(e.target.value)} /></div>
                  {method === "Bank Transfer" && (
                    <div className="form-field form-field--full"><label>Bank Reference / Slip No.</label>
                      <input value={reference} onChange={e => setReference(e.target.value)} placeholder="e.g. BNK-884201" /></div>
                  )}
                  <div className="form-field form-field--full"><label>Notes <span className="optional">(optional)</span></label>
                    <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></div>
                </div>
              </div>
            )}

            <div className="form-actions">
              <button className="btn-ghost" onClick={close}>Cancel</button>
              <button className="btn-primary" disabled={!studentId || !amount} onClick={submit}>Save &amp; Generate Receipt</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK ADD STUDENT MODAL — NOW WITH TRANSPORT TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════
type StudentDraft = {
  name:          string;
  stream:        Stream;
  guardian:      string;
  usesTransport: boolean;   // NEW
};

function BulkAddStudentModal({ defaultStream, onAdd }: {
  defaultStream?: Stream;
  onAdd: (students: Array<Omit<Student, "id" | "expectedFees">>) => void;
}) {
  const blank = (): StudentDraft => ({ name: "", stream: defaultStream ?? "PP1", guardian: "", usesTransport: false });
  const [open, setOpen]     = useState(false);
  const [drafts, setDrafts] = useState<StudentDraft[]>([blank()]);

  const setField = <K extends keyof StudentDraft>(i: number, field: K, value: StudentDraft[K]) =>
    setDrafts(p => p.map((d, idx) => idx === i ? { ...d, [field]: value } : d));

  const addRow    = () => setDrafts(p => [...p, blank()]);
  const removeRow = (i: number) => setDrafts(p => p.filter((_, idx) => idx !== i));

  const submit = () => {
    const valid = drafts.filter(d => d.name.trim());
    if (valid.length === 0) { toast.error("Enter at least one student name"); return; }
    onAdd(valid.map(d => ({
      name:          d.name.trim(),
      stream:        d.stream,
      guardian:      d.guardian.trim() || undefined,
      usesTransport: d.usesTransport,
    })));
    setOpen(false);
    setDrafts([blank()]);
  };

  const close = () => { setOpen(false); setDrafts([blank()]); };

  return (
    <>
      <style>{`
        .modal--bulk { max-width: 820px; width: 96vw; }
        .bulk-hint { font-size:.8rem; color:var(--c-text-3,#888); margin:0 0 1rem; }
        .bulk-table { display:flex; flex-direction:column; gap:.4rem; margin-bottom:.75rem; }
        /* grid: name | class | guardian | transport | remove */
        .bulk-header,
        .bulk-row    { display:grid; grid-template-columns:1fr 110px 1fr 130px 28px; gap:.5rem; align-items:center; }
        .bulk-header { font-size:.65rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
                        color:var(--c-text-3,#999); padding:0 2px; }
        .bulk-input, .bulk-select {
          width:100%; padding:.42rem .6rem; border:1px solid var(--c-border,#dde1e7);
          border-radius:6px; font-size:.85rem; background:var(--c-surface,#fff);
          color:var(--c-text,#111); outline:none; transition:border-color .15s;
        }
        .bulk-input:focus,.bulk-select:focus { border-color:var(--c-primary,#2563eb); }
        .bulk-remove {
          display:flex; align-items:center; justify-content:center;
          width:28px; height:28px; border:none; border-radius:6px; cursor:pointer;
          background:transparent; color:var(--c-danger,#dc2626); font-size:.9rem; transition:background .15s;
        }
        .bulk-remove:hover:not(:disabled) { background:#fee2e2; }
        .bulk-remove:disabled { opacity:.3; cursor:default; }
        .bulk-add-row {
          display:inline-flex; align-items:center; gap:.3rem; font-size:.82rem;
          color:var(--c-primary,#2563eb); background:none; border:none; cursor:pointer;
          padding:.25rem 0; margin-bottom:.75rem; font-weight:600;
        }
        .bulk-add-row:hover { text-decoration:underline; }

        /* Transport toggle pill */
        .transport-toggle {
          display: flex; align-items: center; gap: .35rem;
          font-size: .78rem; font-weight: 600; cursor: pointer;
          user-select: none;
        }
        .transport-toggle input[type=checkbox] { display:none; }
        .transport-pill {
          display: inline-flex; align-items: center; gap: .3rem;
          padding: .25rem .6rem; border-radius: 999px; border: 1.5px solid;
          transition: background .15s, color .15s, border-color .15s;
          white-space: nowrap; font-size: .75rem;
        }
        .transport-pill--off  { background: #f1f5f9; color: #64748b; border-color: #cbd5e1; }
        .transport-pill--on   { background: #eff6ff; color: #1d4ed8; border-color: #93c5fd; }

        /* Transport badge in table */
        .transport-badge { display:inline-flex; align-items:center; gap:.25rem;
          font-size:.72rem; font-weight:700; padding:.15rem .5rem; border-radius:999px; }
        .transport-badge--yes { background:#eff6ff; color:#1d4ed8; border:1px solid #93c5fd; }
        .transport-badge--no  { background:#f8fafc; color:#64748b; border:1px solid #cbd5e1; }
        .student-row-meta { font-size:.72rem; color:var(--c-text-3,#888); }
      `}</style>

      <button className="btn-outline" onClick={() => setOpen(true)}>+ Add Student</button>

      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal modal--bulk" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Add Students</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>

            <p className="bulk-hint">Add one or more students. Each row is one student.</p>

            <div className="bulk-table">
              <div className="bulk-header">
                <span>Full Name <span className="required">*</span></span>
                <span>Class</span>
                <span>Guardian <span className="optional">(optional)</span></span>
                <span>Student Type</span>
                <span></span>
              </div>

              {drafts.map((d, i) => (
                <div key={i} className="bulk-row">
                  {/* Name */}
                  <input className="bulk-input" value={d.name}
                    onChange={e => setField(i, "name", e.target.value)}
                    placeholder="e.g. Amani Wanjiku" autoFocus={i === 0} />

                  {/* Class */}
                  <select className="bulk-select" value={d.stream}
                    onChange={e => setField(i, "stream", e.target.value as Stream)}>
                    {STREAMS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>

                  {/* Guardian */}
                  <input className="bulk-input" value={d.guardian}
                    onChange={e => setField(i, "guardian", e.target.value)}
                    placeholder="e.g. Jane Doe" />

                  {/* Transport toggle */}
                  <label className="transport-toggle" title={d.usesTransport ? "Uses school transport" : "Day student (no transport)"}>
                    <input type="checkbox" checked={d.usesTransport}
                      onChange={e => setField(i, "usesTransport", e.target.checked)} />
                    <span className={`transport-pill transport-pill--${d.usesTransport ? "on" : "off"}`}>
                      {d.usesTransport ? "🚌 Transport" : "🚶 Day only"}
                    </span>
                  </label>

                  {/* Remove row */}
                  <button className="bulk-remove" onClick={() => removeRow(i)}
                    disabled={drafts.length === 1} title="Remove row">✕</button>
                </div>
              ))}
            </div>

            <button className="bulk-add-row" onClick={addRow}>+ Add another student</button>

            <div className="form-actions">
              <button className="btn-ghost" onClick={close}>Cancel</button>
              <button className="btn-primary" onClick={submit}>
                Enrol {drafts.filter(d => d.name.trim()).length || ""}{" "}
                Student{drafts.filter(d => d.name.trim()).length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT FEES MODAL — TWO COLUMNS: DAY vs DAY + TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════════
function EditFeesModal({
  termFees, termFeesTransport, onUpdate,
}: {
  termFees:          TermFeeMap;
  termFeesTransport: TermFeeTransportMap;
  onUpdate: (stream: Stream, bucket: "base" | "transport", amount: number) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);

  // Draft state for both buckets per stream
  const [draftsBase, setDraftsBase] = useState<Record<Stream, string>>(
    () => Object.fromEntries(STREAMS.map(s => [s, String(termFees[s])])) as Record<Stream, string>
  );
  const [draftsTransport, setDraftsTransport] = useState<Record<Stream, string>>(
    () => Object.fromEntries(STREAMS.map(s => [s, String(termFeesTransport[s])])) as Record<Stream, string>
  );

  const openModal = () => {
    setDraftsBase(Object.fromEntries(STREAMS.map(s => [s, String(termFees[s])])) as Record<Stream, string>);
    setDraftsTransport(Object.fromEntries(STREAMS.map(s => [s, String(termFeesTransport[s])])) as Record<Stream, string>);
    setOpen(true);
  };

  const saveAll = async () => {
    for (const s of STREAMS) {
      const base      = Number(draftsBase[s]);
      const transport = Number(draftsTransport[s]);
      if (!base      || base <= 0)      { toast.error(`Invalid day fee for ${s}`);       return; }
      if (!transport || transport <= 0) { toast.error(`Invalid transport fee for ${s}`); return; }
      if (transport < base)             { toast.error(`Transport fee for ${s} should be ≥ day fee`); return; }
    }
    for (const s of STREAMS) {
      await onUpdate(s, "base",      Number(draftsBase[s]));
      await onUpdate(s, "transport", Number(draftsTransport[s]));
    }
    setOpen(false);
    toast.success("All term fees updated");
  };

  return (
    <>
      <style>{`
        .fees-modal { max-width: 640px; width: 95vw; }
        .fees-cols-header {
          display: grid; grid-template-columns: 110px 1fr 1fr;
          gap: .5rem; margin-bottom: .5rem; padding: 0 2px;
          font-size: .65rem; font-weight: 700; letter-spacing: .1em;
          text-transform: uppercase; color: var(--c-text-3, #888);
        }
        .fees-cols-header span:nth-child(2) { color: #475569; }
        .fees-cols-header span:nth-child(3) { color: #1d4ed8; }
        .fees-row {
          display: grid; grid-template-columns: 110px 1fr 1fr;
          gap: .5rem; align-items: center; padding: .35rem 0;
          border-bottom: 1px solid var(--c-border, #eee);
        }
        .fees-row:last-child { border-bottom: none; }
        .fees-stream { font-weight: 600; font-size: .88rem; }
        .fees-input {
          width: 100%; padding: .42rem .6rem; border: 1px solid var(--c-border, #dde1e7);
          border-radius: 6px; font-size: .85rem; outline: none; transition: border-color .15s;
          background: var(--c-surface, #fff); color: var(--c-text, #111);
        }
        .fees-input:focus { border-color: var(--c-primary, #2563eb); }
        .fees-input--transport { border-color: #bfdbfe; background: #f0f9ff; }
        .fees-input--transport:focus { border-color: #3b82f6; }
        .fees-hint {
          font-size: .73rem; color: var(--c-text-3, #888);
          margin: .75rem 0 1.25rem;
          padding: .55rem .75rem;
          background: #f8fafc;
          border-radius: 6px;
          border-left: 3px solid #94a3b8;
        }
      `}</style>

      <button className="btn-outline" onClick={openModal}>Edit Term Fees</button>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal fees-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Base Term Fees — {CURRENT_TERM.label}</h3>
              <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>

            <p className="fees-hint">
              <strong>Day student</strong> — attends school but uses own transport.<br />
              <strong>Day + Transport</strong> — uses the school bus. This fee must be ≥ the day fee.
            </p>

            {/* Two-column header */}
            <div className="fees-cols-header">
              <span>Class</span>
              <span>🚶 Day student (TZS)</span>
              <span>🚌 Day + Transport (TZS)</span>
            </div>

            <div className="fees-grid">
              {STREAMS.map(s => (
                <div key={s} className="fees-row">
                  <span className="fees-stream">{s}</span>

                  {/* Base / day fee */}
                  <input
                    className="fees-input"
                    type="number"
                    min="0"
                    value={draftsBase[s]}
                    onChange={e => setDraftsBase(p => ({ ...p, [s]: e.target.value }))}
                  />

                  {/* Transport fee */}
                  <input
                    className="fees-input fees-input--transport"
                    type="number"
                    min="0"
                    value={draftsTransport[s]}
                    onChange={e => setDraftsTransport(p => ({ ...p, [s]: e.target.value }))}
                  />
                </div>
              ))}
            </div>

            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={saveAll}>Save All Fees</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Edit Student Modal (now includes transport toggle) ────────────────────────
function EditStudentModal({ student, onSave }: { student: Student; onSave: (s: Student) => void }) {
  const [open,          setOpen]          = useState(false);
  const [name,          setName]          = useState(student.name);
  const [guardian,      setGuardian]      = useState(student.guardian ?? "");
  const [fees,          setFees]          = useState(String(student.expectedFees));
  const [usesTransport, setUsesTransport] = useState(student.usesTransport);

  const submit = () => {
    if (!name.trim() || !Number(fees)) { toast.error("Name and fees required"); return; }
    onSave({ ...student, name: name.trim(), guardian: guardian.trim() || undefined, expectedFees: Number(fees), usesTransport });
    setOpen(false);
  };

  return (
    <>
      <button className="action-btn" onClick={() => {
        setOpen(true); setName(student.name); setGuardian(student.guardian ?? "");
        setFees(String(student.expectedFees)); setUsesTransport(student.usesTransport);
      }}>Edit</button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal modal--sm" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Edit Student</h3>
              <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="form-grid">
              <div className="form-field form-field--full">
                <label>Full Name</label>
                <input value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="form-field form-field--full">
                <label>Guardian <span className="optional">(optional)</span></label>
                <input value={guardian} onChange={e => setGuardian(e.target.value)} />
              </div>
              <div className="form-field form-field--full">
                <label>Student Type</label>
                <label className="transport-toggle" style={{ marginTop: ".25rem" }}>
                  <input type="checkbox" style={{ display: "none" }} checked={usesTransport}
                    onChange={e => setUsesTransport(e.target.checked)} />
                  <span className={`transport-pill transport-pill--${usesTransport ? "on" : "off"}`}>
                    {usesTransport ? "🚌 Day + Transport" : "🚶 Day only (no transport)"}
                  </span>
                  <span style={{ fontSize: ".75rem", color: "var(--c-text-3,#888)", marginLeft: ".35rem" }}>
                    (click to toggle)
                  </span>
                </label>
              </div>
              <div className="form-field form-field--full">
                <label>Expected Fees (TZS)</label>
                <input type="number" value={fees} onChange={e => setFees(e.target.value)} />
              </div>
            </div>
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={submit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Move Student Modal (unchanged) ────────────────────────────────────────────
function MoveStudentModal({ student, currentStream, onMove }: { student: Student; currentStream: Stream; onMove: (s: Stream) => void }) {
  const [open, setOpen]     = useState(false);
  const [target, setTarget] = useState<Stream>(currentStream);

  return (
    <>
      <button className="action-btn" onClick={() => setOpen(true)}>Move</button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal modal--sm" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Move Student</h3>
              <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="form-field">
              <label>Move {student.name} to</label>
              <select value={target} onChange={e => setTarget(e.target.value as Stream)}>
                {STREAMS.filter(s => s !== currentStream).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={() => { onMove(target); setOpen(false); }}>Move</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Allocate Inline (unchanged) ───────────────────────────────────────────────
function AllocateInline({ entryId: _entryId, students, onAllocate }: { entryId: string; students: Student[]; onAllocate: (studentId: string) => void }) {
  const [open, setOpen]                     = useState(false);
  const [selectedStream, setSelectedStream] = useState<Stream | "">("");
  const [studentSearch, setStudentSearch]   = useState("");
  const [studentId, setStudentId]           = useState("");

  const streamStudents = useMemo(() => {
    if (!selectedStream) return [];
    const base = students.filter(s => s.stream === selectedStream);
    const q    = studentSearch.trim().toLowerCase();
    return q ? base.filter(s => s.name.toLowerCase().includes(q)) : base;
  }, [students, selectedStream, studentSearch]);

  const close = () => { setOpen(false); setSelectedStream(""); setStudentSearch(""); setStudentId(""); };

  return (
    <>
      <button className="action-btn" onClick={() => setOpen(true)}>Allocate</button>
      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal modal--sm" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Allocate to Student</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>
            <div className="step-block">
              <div className="step-label"><span className="step-num">1</span> Select Class</div>
              <div className="stream-picker">
                {STREAMS.map(s => (
                  <button key={s} className={`stream-chip${selectedStream === s ? " stream-chip--active" : ""}`}
                    onClick={() => { setSelectedStream(s); setStudentId(""); setStudentSearch(""); }}>{s}</button>
                ))}
              </div>
            </div>
            {selectedStream && (
              <div className="step-block">
                <div className="step-label"><span className="step-num">2</span> Select Student</div>
                <input className="student-search" placeholder="Filter by name…" value={studentSearch}
                  onChange={e => { setStudentSearch(e.target.value); setStudentId(""); }} autoFocus />
                <div className="student-list">
                  {streamStudents.map(s => (
                    <button key={s.id} className={`student-row${studentId === s.id ? " student-row--active" : ""}`}
                      onClick={() => setStudentId(s.id)}>
                      <span className="student-row-name">{s.name}</span>
                      <span className="student-row-meta">{s.usesTransport ? "🚌 Transport" : "🚶 Day"}</span>
                    </button>
                  ))}
                  {streamStudents.length === 0 && <div className="student-list-empty">No students found.</div>}
                </div>
              </div>
            )}
            <div className="form-actions">
              <button className="btn-ghost" onClick={close}>Cancel</button>
              <button className="btn-primary" disabled={!studentId}
                onClick={() => { if (!studentId) { toast.error("Select a student"); return; } onAllocate(studentId); close(); }}>
                Confirm Allocation
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Receipt Modal (unchanged) ─────────────────────────────────────────────────
function ReceiptModal({ tx, student, onClose }: { tx: Transaction; student?: Student; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const print = () => {
    const html = ref.current?.innerHTML ?? "";
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Receipt</title><style>
      body{font-family:'Segoe UI',sans-serif;max-width:460px;margin:40px auto;color:#111;}
      h1{font-size:1.3rem;margin-bottom:2px;font-style:italic;color:#8a6200;}
      .sub{font-size:0.65rem;letter-spacing:.15em;text-transform:uppercase;color:#888;margin-bottom:1.2rem;}
      table{width:100%;border-collapse:collapse;}
      td{padding:5px 0;font-size:.88rem;}
      td:first-child{color:#666;width:42%;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;}
      .amount{font-size:1.6rem;font-weight:700;color:#1a6b3a;font-family:monospace;}
      hr{border:none;border-top:1px dashed #ccc;margin:12px 0;}
      .footer{font-size:.68rem;color:#aaa;text-align:center;margin-top:1rem;line-height:1.7;}
    </style></head><body>${html}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal receipt-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Payment Receipt</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div ref={ref} className="receipt-body">
          <h1>Madam Paradise School</h1>
          <p className="sub">Official Fee Receipt</p>
          <table><tbody>
            <tr><td>Receipt No.</td><td><span className="mono-cell">{tx.id.toUpperCase()}</span></td></tr>
            <tr><td>Date</td><td>{tx.date}</td></tr>
            {student && <tr><td>Student</td><td>{student.name}</td></tr>}
            {student && <tr><td>Class</td><td>{student.stream}</td></tr>}
            {student && <tr><td>Student Type</td><td>{student.usesTransport ? "Day + Transport" : "Day only"}</td></tr>}
            {student?.guardian && <tr><td>Guardian</td><td>{student.guardian}</td></tr>}
            <tr><td>Method</td><td>{tx.method}</td></tr>
            {tx.reference && <tr><td>Reference</td><td><span className="mono-cell">{tx.reference}</span></td></tr>}
            <tr><td>Received By</td><td>{tx.receivedBy}</td></tr>
            {tx.notes && <tr><td>Notes</td><td>{tx.notes}</td></tr>}
          </tbody></table>
          <hr />
          <table><tbody>
            <tr><td>Amount Paid</td><td><span className="amount">{fmt(tx.amount)}</span></td></tr>
            {student && <tr><td>Term Fee</td><td>{fmt(student.expectedFees)}</td></tr>}
          </tbody></table>
          <p className="footer">Official receipt — retain for your records.<br />Madam Paradise School · {CURRENT_TERM.label}</p>
        </div>
        <div className="form-actions">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={print}>Print Receipt</button>
        </div>
      </div>
    </div>
  );
}