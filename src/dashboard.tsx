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

type StudentType = "Day" | "Transport" | "Boarder";

// NEW: Global Fees structure replacing per-class JSONB
type GlobalFees = {
  dayBase: number;        // e.g., 200000
  transportBase: number;  // e.g., 250000
  boarderBase: number;    // e.g., 325000
  tuitionBoarder: number; // e.g., 130000
  tuitionDay: number;     // e.g., 60000
  library: number;
  caution: number;
  registration: number;
  uniforms: {
    fullUpper: number;    // 70000 (Class 1-7)
    fullLower: number;    // 60000 (PP1-PP2)
    tracksuit: number;    // 30000
    boys: { sweater: number; tshirt: number; socks: number; khakiShorts: number; greenShorts: number; weekend: number };
    girls: { sweater: number; tshirt: number; socks: number; skirt: number; weekend: number };
  };
};

type Student = {
  id:            string;
  name:          string;
  stream:        Stream;
  guardian?:     string;
  phone?:        string;      // NEW
  type:          StudentType; // NEW
  expectedFees:  number;
  walletBalance: number;
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
  id:                string;
  full_name:         string;
  class_id:          string;
  guardian:          string | null;
  parent_phone:      string | null;  // NEW
  student_type:      StudentType;    // NEW
  classes:           { name: string } | { name: string }[] | null;
  student_term_fees: Array<{ expected_fee: number; term_id?: string }> | null;
  wallet_balance: number;
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

// Fee calculation — all amounts are YEARLY totals.
// Tuition applies to Class 4 & 7 (paid once in July, included in yearly total here).
// Registration is a one-off for brand-new students only.
function calculateExpectedFees(
  stream: Stream,
  type: StudentType,
  isNew: boolean,
  globalFees: GlobalFees,
): number {
  let total = 0;

  // 1. Annual school fees based on student type
  if (type === "Boarder")        total += globalFees.boarderBase;
  else if (type === "Transport") total += globalFees.transportBase;
  else                           total += globalFees.dayBase;

  // 2. Annual mandatory add-ons (library, caution — charged once a year)
  total += globalFees.library;
  total += globalFees.caution;

  // 3. Tuition (July — Class 7 always boarder rate; Class 4 depends on type)
  if (stream === "Class 7") {
    total += globalFees.tuitionBoarder;
  } else if (stream === "Class 4") {
    total += (type === "Boarder") ? globalFees.tuitionBoarder : globalFees.tuitionDay;
  }

  // 4. One-off registration fee for new students
  if (isNew) total += globalFees.registration;

  return total;
}

// ─── Academic year helper ────────────────────────────────────────────────────
// Fees are annual — no per-term splitting. We only need the year label.
type TermLabel = { number: 1; year: number; label: string; start: string; end: string };

function getCurrentTerm(): TermLabel {
  const year = new Date().getFullYear();
  return { number: 1, year, label: `Academic Year ${year}`, start: `${year}-01-01`, end: `${year}-12-31` };
}

const CURRENT_TERM = getCurrentTerm();

// Map a StudentRow → Student UI type
const studentFromRow = (r: StudentRow, globalFees: GlobalFees): Student => {
  const classesObj = Array.isArray(r.classes) ? r.classes[0] : r.classes;
  const stream     = (classesObj?.name ?? "") as Stream;
  const type       = r.student_type ?? "Day";
  const stfFee     = r.student_term_fees?.[0]?.expected_fee;

  // Yearly baseline — no term number needed
  const baseline     = calculateExpectedFees(stream, type, false, globalFees);
  const expectedFees = stfFee != null ? stfFee : baseline;

  return {
    id:            r.id,
    name:          r.full_name,
    stream,
    guardian:      r.guardian ?? undefined,
    phone:         r.parent_phone ?? undefined,
    type,
    expectedFees,
    walletBalance: Number(r.wallet_balance || 0),
  };
};

const txFromRow = (r: TransactionRow): Transaction => ({
  id: r.id, date: r.payment_date, studentId: r.student_id, amount: r.amount,
  method: r.method, reference: r.reference ?? undefined,
  receivedBy: r.received_by, notes: r.notes ?? undefined,
});

const unallocFromRow   = (r: UnallocatedRow): Unallocated => ({
  id: r.id, date: r.deposit_date, amount: r.amount, method: r.method,
  reference: r.reference ?? undefined, depositorName: r.depositor_name ?? undefined, reason: r.reason,
});

type Page = "overview" | "transactions" | "unallocated" | "uniforms" | { type: "class"; stream: Stream };

const DEFAULT_GLOBAL_FEES: GlobalFees = {
  dayBase:        800000,   // per year — PP1 to Class 6, no transport
  transportBase: 1000000,   // per year — PP1 to Class 6, with school bus
  boarderBase:   1300000,   // per year — all boarders (Class 7 required)
  tuitionBoarder:  130000,  // July tuition — Class 7 boarders & Class 4 boarders
  tuitionDay:       60000,  // July tuition — Class 4 day scholars
  library: 0,
  caution: 0,
  registration: 0,
  uniforms: {
    fullUpper: 70000, fullLower: 60000, tracksuit: 30000,
    boys: { sweater: 0, tshirt: 0, socks: 0, khakiShorts: 0, greenShorts: 0, weekend: 0 },
    girls: { sweater: 0, tshirt: 0, socks: 0, skirt: 0, weekend: 0 }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════════
export default function Dashboard() {
const [globalFees, setGlobalFees] = useState<GlobalFees>(DEFAULT_GLOBAL_FEES);
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
          .select("id")
          .eq("year", CURRENT_TERM.year)
          .maybeSingle();
        const termId: string | null = (termData as { id: string } | null)?.id ?? null;

        // Fetch the master fees from our new settings table!
        const { data: settings } = await supabase.from("settings").select("global_fees").maybeSingle();
        
        // FIX: Use a local variable to hold the fetched fees so we don't need 
        // to put globalFees in the dependency array below (which caused the infinite loop)
       let activeFees = DEFAULT_GLOBAL_FEES; // Use the constant, not the state variable!
        if (settings?.global_fees) {
          activeFees = settings.global_fees;
          setGlobalFees(activeFees);
        }

        const [classesRes, studentsRes, txsRes, unallocRes] = await Promise.all([
          supabase.from("classes").select("id, name").order("sort_order"),
          supabase
            .from("students")
            .select("id, full_name, class_id, guardian, parent_phone, student_type, wallet_balance, classes(name), student_term_fees(expected_fee, term_id)")
            .eq("is_active", true)
            .order("full_name"),
          supabase
            .from("transactions")
            .select("id, payment_date, student_id, amount, method, reference, received_by, notes")
            // Removed date filters so the cumulative wallet calculation works!
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

        const rawStudents = (studentsRes.data ?? []) as Array<StudentRow & {
          student_term_fees: Array<{ expected_fee: number; term_id?: string }> | null;
        }>;
        
        const filteredStudents = rawStudents.map(s => ({
          ...s,
          student_term_fees: termId
            ? (s.student_term_fees ?? []).filter(f => f.term_id === termId)
            : (s.student_term_fees ?? []),
        }));
        
        // Pass the activeFees we just fetched
        setStudents(filteredStudents.map(s => studentFromRow(s as StudentRow, activeFees)));
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

  const addStudents = async (
    newStudents: Array<Omit<Student, "id" | "expectedFees" | "walletBalance"> & { isNew: boolean }>
  ) => {
    if (newStudents.length === 0) return;

    const streamSet = [...new Set(newStudents.map(s => s.stream))];
    const { data: classRows, error: classErr } = await supabase
      .from("classes").select("id, name").in("name", streamSet);
    if (classErr) { toast.error(classErr.message); return; }

    const classMap = Object.fromEntries(
      (classRows ?? []).map((r: { id: string; name: string }) => [r.name, r])
    );

    const insertRows = newStudents.map(s => {
      const cls = classMap[s.stream];
      if (!cls) throw new Error(`Class "${s.stream}" not found`);
      return {
        full_name:      s.name,
        class_id:       cls.id,
        guardian:       s.guardian ?? null,
        parent_phone:   s.phone ?? null,
        student_type:   s.type,
      };
    });

    const { data, error } = await supabase
      .from("students")
      .insert(insertRows)
      .select("id, full_name, class_id, guardian, parent_phone, student_type, wallet_balance, classes(name), student_term_fees(expected_fee, term_id)");
    if (error) { toast.error(error.message); return; }

    const added = (data ?? []).map(r => studentFromRow(r as unknown as StudentRow, globalFees));
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
      .update({ 
        full_name: s.name, 
        class_id: classRow.id, 
        guardian: s.guardian ?? null, 
        parent_phone: s.phone ?? null, 
        student_type: s.type 
      })
      .eq("id", s.id)
      .select("id, full_name, class_id, guardian, parent_phone, student_type, classes(name), student_term_fees(expected_fee, term_id)")
      .single();
    if (error) { toast.error(error.message); return; }
    setStudents(p => p.map(x => x.id === s.id ? studentFromRow(data as unknown as StudentRow, globalFees) : x));
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
      .select("id, full_name, class_id, guardian, parent_phone, student_type, classes(name), student_term_fees(expected_fee, term_id)")
      .single();
    if (error) { toast.error(error.message); return; }
    setStudents(p => p.map(s => s.id === id ? studentFromRow(data as unknown as StudentRow, globalFees) : s));
    toast.success("Student moved to " + to);
  };

const updateGlobalFees = async (newFees: GlobalFees) => {
    setGlobalFees(newFees);
    setStudents(p => p.map(s => {
      const baseline = calculateExpectedFees(s.stream, s.type, false, newFees);
      return { ...s, expectedFees: baseline };
    }));
    toast.success("Global fees updated!");
  };
  const recordTx = async (t: Omit<Transaction, "id">) => {
    if (!t.studentId) { toast.error("No student selected"); return; }
    const student = studentLookup[t.studentId];
    if (!student) { toast.error("Student not found"); return; }

    // 1. Insert the real payment — term_id is auto-filled by DB trigger
    const { data, error } = await supabase
      .from("transactions")
      .insert({
        payment_date: t.date,
        student_id:   t.studentId,
        amount:       t.amount,
        method:       t.method,
        reference:    t.reference ?? null,
        received_by:  t.receivedBy,
        notes:        t.notes ?? null,
      })
      .select("id, payment_date, student_id, amount, method, reference, received_by, notes")
      .single();

    if (error) { toast.error(error.message); return; }
    const tx = txFromRow(data as TransactionRow);
    const newTransactionsToAdd: Transaction[] = [tx];

    // 2. Wallet logic — move any excess above what is owed into the wallet
    const currentPaid = transactions
      .filter(x => x.studentId === student.id && x.amount > 0)
      .reduce((a, x) => a + x.amount, 0);
    const balanceOwed = Math.max(0, student.expectedFees - currentPaid - student.walletBalance);

    if (t.amount > balanceOwed && balanceOwed >= 0) {
      const excess = t.amount - balanceOwed;
      const newWallet = student.walletBalance + excess;

      // Update wallet in DB
      await supabase
        .from("students")
        .update({ wallet_balance: newWallet })
        .eq("id", student.id);

      // Update wallet in local state
      setStudents(p => p.map(s =>
        s.id === student.id ? { ...s, walletBalance: newWallet } : s
      ));

      // Insert a system offset row so collected totals stay accurate
      const { data: offsetData } = await supabase
        .from("transactions")
        .insert({
          payment_date: t.date,
          student_id:   student.id,
          amount:       -excess,
          method:       t.method,
          received_by:  "System",
          notes:        `Wallet credit (Ref: ${tx.id})`,
        })
        .select("id, payment_date, student_id, amount, method, reference, received_by, notes")
        .single();

      if (offsetData) {
        newTransactionsToAdd.unshift(txFromRow(offsetData as TransactionRow));
      }
    }

    setTransactions(prev => [...newTransactionsToAdd, ...prev]);
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
        <span className="mobile-title">Paradise Schools</span>
        <RecordTxBtn students={students} onRecord={recordTx} />
      </div>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-icon">MP</div>
          <div>
            <div className="brand-name">Paradise Schools</div>
            <div className="brand-sub">Fees Management</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          <div className="nav-section-label">Main</div>
          <NavItem icon="⊞" label="Overview" active={page === "overview"} onClick={() => { setPage("overview"); setSidebarOpen(false); }} />
          <NavItem icon="↔" label="Transactions" active={page === "transactions"} badge={transactions.length} onClick={() => { setPage("transactions"); setSidebarOpen(false); }} />
          <NavItem icon="◎" label="Unallocated" active={page === "unallocated"} badge={unallocated.length > 0 ? unallocated.length : undefined} badgeAlert onClick={() => { setPage("unallocated"); setSidebarOpen(false); }} />
          <NavItem 
  icon="" 
  label="Uniform Sales" 
  active={page === "uniforms"} 
  onClick={() => { setPage("uniforms"); setSidebarOpen(false); }} 
/>
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
                <EditFeesModal globalFees={globalFees} onUpdateFees={updateGlobalFees} />
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
                     <div className="class-fee-label">Day {fmt(globalFees.dayBase)} · Transport {fmt(globalFees.transportBase)} · Boarder {fmt(globalFees.boarderBase)} <span style={{fontSize:"0.7rem",opacity:.7}}>/yr</span></div>
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
  
  // Balance calculation uses the wallet credit!
  const balance = s.expectedFees - paid - s.walletBalance;
  
  const status: "cleared" | "partial" | "unpaid" =
    balance <= 0 ? "cleared"
    : (paid + s.walletBalance) > 0 ? "partial"
    : "unpaid";
  return { ...s, paid, balance, status };
});
            const classTxs = transactions.filter(t => activeStudents.some(s => s.id === t.studentId));

            return (
              <div className="fade-in">
                <div className="stat-grid">
                 <StatCard label="Enrolled"    value={String(stats.count)} hint={`Day ${fmt(globalFees.dayBase)} · Boarder ${fmt(globalFees.boarderBase)} /yr`} />
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
                          <td className="name-cell">
  {s.name}
  {s.walletBalance > 0 && (
    <span style={{ marginLeft: "8px", fontSize: "0.7rem", padding: "2px 6px", background: "#dcfce7", color: "#166534", borderRadius: "4px" }}>
      +{fmt(s.walletBalance)} Wallet
    </span>
  )}
</td>
                          <td className="muted-cell">{s.guardian ?? "—"}</td>
                          <td>
  <span className={`transport-badge transport-badge--${s.type === 'Day' ? "no" : "yes"}`}>
    {s.type === 'Boarder' ? "🛏️ Boarder" : s.type === 'Transport' ? "🚌 Transport" : "🚶 Day"}
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

          )
           }
           {/* UNIFORM SALES */}
          {!loading && page === "uniforms" && (
            <UniformsPage globalFees={globalFees} students={students} onRecord={recordTx} />
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
    onRecord({
      date, studentId, amount: amt, method, reference: reference || undefined, receivedBy, notes: notes || undefined,
    });
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
                       {s.type === 'Boarder' ? "🛏️ Boarder" : s.type === 'Transport' ? "🚌 Transport" : "🚶 Day"}
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
// BULK ADD STUDENT MODAL — UPDATED WITH BOARDING, PHONE, AND REGISTRATION LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

type StudentDraft = {
  name:     string;
  stream:   Stream;
  guardian: string;
  phone:    string;      // NEW
  type:     StudentType; // NEW: "Day" | "Transport" | "Boarder"
  isNew:    boolean;     // NEW
};

function BulkAddStudentModal({ defaultStream, onAdd }: {
  defaultStream?: Stream;
  onAdd: (students: Array<Omit<Student, "id" | "expectedFees" | "walletBalance"> & { isNew: boolean }>) => void;
}) {
  const blank = (): StudentDraft => ({ 
    name: "", 
    stream: defaultStream ?? "PP1", 
    guardian: "", 
    phone: "", 
    type: defaultStream === "Class 7" ? "Boarder" : "Day", 
    isNew: true 
  });
  
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
      name:     d.name.trim(),
      stream:   d.stream,
      guardian: d.guardian.trim() || undefined,
      phone:    d.phone.trim() || undefined,
      type:     d.stream === "Class 7" ? "Boarder" : d.type, // Security override
      isNew:    d.isNew,
    })));
    setOpen(false);
    setDrafts([blank()]);
  };

  const close = () => { setOpen(false); setDrafts([blank()]); };

  return (
    <>
      <style>{`
        .modal--bulk { max-width: 1050px; width: 96vw; }
        .bulk-hint { font-size:.8rem; color:var(--c-text-3,#888); margin:0 0 1rem; }
        .bulk-table { display:flex; flex-direction:column; gap:.4rem; margin-bottom:.75rem; }
        
        /* New Grid: Name | Class | Guardian | Phone | Type | New? | Remove */
        .bulk-header,
        .bulk-row    { display:grid; grid-template-columns: 1.5fr 100px 1.2fr 1fr 120px 60px 28px; gap:.5rem; align-items:center; }
        .bulk-header { font-size:.65rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
                        color:var(--c-text-3,#999); padding:0 2px; }
        
        .bulk-input, .bulk-select {
          width:100%; padding:.42rem .6rem; border:1px solid var(--c-border,#dde1e7);
          border-radius:6px; font-size:.85rem; background:var(--c-surface,#fff);
          color:var(--c-text,#111); outline:none; transition:border-color .15s;
        }
        .bulk-input:focus,.bulk-select:focus { border-color:var(--c-primary,#2563eb); }
        .bulk-select:disabled { background: #f1f5f9; cursor: not-allowed; color: #64748b; }
        
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

        .checkbox-cell { display: flex; justify-content: center; }
        .checkbox-cell input { width: 16px; height: 16px; cursor: pointer; }
      `}</style>

      <button className="btn-outline" onClick={() => setOpen(true)}>+ Add Student</button>

      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal modal--bulk" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Add Students</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>

            <p className="bulk-hint">Add one or more students. Check "New" to automatically apply registration & caution fees.</p>

            <div className="bulk-table">
              <div className="bulk-header">
                <span>Full Name <span className="required">*</span></span>
                <span>Class</span>
                <span>Guardian</span>
                <span>Phone</span>
                <span>Type</span>
                <span style={{textAlign: "center"}}>New?</span>
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
                    onChange={e => {
                      const newStream = e.target.value as Stream;
                      setField(i, "stream", newStream);
                      // Force Boarder if Class 7
                      if (newStream === "Class 7") {
                        setField(i, "type", "Boarder");
                      }
                    }}>
                    {STREAMS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>

                  {/* Guardian */}
                  <input className="bulk-input" value={d.guardian}
                    onChange={e => setField(i, "guardian", e.target.value)}
                    placeholder="e.g. Jane Doe" />

                  {/* Phone */}
                  <input className="bulk-input" value={d.phone} type="tel"
                    onChange={e => setField(i, "phone", e.target.value)}
                    placeholder="07XX..." />

                  {/* Student Type */}
                  <select 
                    className="bulk-select" 
                    value={d.type}
                    disabled={d.stream === "Class 7"}
                    title={d.stream === "Class 7" ? "Class 7 students must be Boarders" : ""}
                    onChange={e => setField(i, "type", e.target.value as StudentType)}>
                    <option value="Day">Day Scholar</option>
                    <option value="Transport">Transport</option>
                    <option value="Boarder">Boarder</option>
                  </select>

                  {/* Is New Toggle */}
                  <div className="checkbox-cell" title="Applies Registration and Caution fees">
                    <input type="checkbox" checked={d.isNew} 
                      onChange={e => setField(i, "isNew", e.target.checked)} />
                  </div>

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
// ═══════════════════════════════════════════════════════════════════════════════
// EDIT FEES MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function EditFeesModal({
  globalFees, onUpdateFees,
}: {
  globalFees: GlobalFees;
  onUpdateFees: (newFees: GlobalFees) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<GlobalFees>(globalFees);

  const openModal = () => { setDraft(globalFees); setOpen(true); };

  const saveAll = async () => {
    await onUpdateFees(draft);
    setOpen(false);
  };

  const updateDraft = (key: keyof GlobalFees, val: number) => setDraft(p => ({ ...p, [key]: val }));
  
  const updateUniform = (key: keyof GlobalFees["uniforms"], val: number) => 
    setDraft(p => ({ ...p, uniforms: { ...p.uniforms, [key]: val } }));

  const updateBoysUniform = (key: keyof GlobalFees["uniforms"]["boys"], val: number) => 
    setDraft(p => ({ ...p, uniforms: { ...p.uniforms, boys: { ...p.uniforms.boys, [key]: val } } }));

  const updateGirlsUniform = (key: keyof GlobalFees["uniforms"]["girls"], val: number) => 
    setDraft(p => ({ ...p, uniforms: { ...p.uniforms, girls: { ...p.uniforms.girls, [key]: val } } }));

  return (
    <>
      <button className="btn-outline" onClick={openModal}>⚙️ Edit Fees & Uniforms</button>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal" style={{ maxWidth: "800px", width: "95vw" }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Edit Global Fees & Pricing</h3>
              <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>

            <div className="scrollable-content" style={{ maxHeight: "65vh", overflowY: "auto", paddingRight: "10px" }}>
              
              <h4 style={{ margin: "1rem 0 .5rem" }}>School Fees (Annual — full year)</h4>
              <div className="form-grid">
                <div className="form-field"><label>Day Scholar — No Transport (TZS / year)</label>
                  <input type="number" value={draft.dayBase} onChange={e => updateDraft("dayBase", Number(e.target.value))} /></div>
                <div className="form-field"><label>Day Scholar — With Transport (TZS / year)</label>
                  <input type="number" value={draft.transportBase} onChange={e => updateDraft("transportBase", Number(e.target.value))} /></div>
                <div className="form-field"><label>Boarding Fees (TZS / year)</label>
                  <input type="number" value={draft.boarderBase} onChange={e => updateDraft("boarderBase", Number(e.target.value))} /></div>
              </div>

              <h4 style={{ margin: "1rem 0 .5rem" }}>Tuition & Mandatory Fees</h4>
              <div className="form-grid">
                <div className="form-field"><label>Tuition (Boarders - Cls 4 & 7)</label>
                  <input type="number" value={draft.tuitionBoarder} onChange={e => updateDraft("tuitionBoarder", Number(e.target.value))} /></div>
                <div className="form-field"><label>Tuition (Day - Cls 4)</label>
                  <input type="number" value={draft.tuitionDay} onChange={e => updateDraft("tuitionDay", Number(e.target.value))} /></div>
                <div className="form-field"><label>Library Fee</label>
                  <input type="number" value={draft.library} onChange={e => updateDraft("library", Number(e.target.value))} /></div>
              </div>

              <h4 style={{ margin: "1rem 0 .5rem" }}>New Registration Fees</h4>
              <div className="form-grid">
                <div className="form-field"><label>Registration Fee</label>
                  <input type="number" value={draft.registration} onChange={e => updateDraft("registration", Number(e.target.value))} /></div>
                <div className="form-field"><label>Caution Fee</label>
                  <input type="number" value={draft.caution} onChange={e => updateDraft("caution", Number(e.target.value))} /></div>
              </div>

              <h4 style={{ margin: "1rem 0 .5rem" }}>Uniform Sets</h4>
              <div className="form-grid">
                <div className="form-field"><label>Full Uniform (Class 1-7)</label>
                  <input type="number" value={draft.uniforms.fullUpper} onChange={e => updateUniform("fullUpper", Number(e.target.value))} /></div>
                <div className="form-field"><label>Full Uniform (PP1-PP2)</label>
                  <input type="number" value={draft.uniforms.fullLower} onChange={e => updateUniform("fullLower", Number(e.target.value))} /></div>
                <div className="form-field"><label>Tracksuit</label>
                  <input type="number" value={draft.uniforms.tracksuit} onChange={e => updateUniform("tracksuit", Number(e.target.value))} /></div>
              </div>
              
              <h4 style={{ margin: "1.5rem 0 .5rem", color: "var(--c-primary)" }}>Boys Uniform Pricing</h4>
              <div className="form-grid">
                <div className="form-field"><label>Sweater</label>
                  <input type="number" value={draft.uniforms.boys.sweater} onChange={e => updateBoysUniform("sweater", Number(e.target.value))} /></div>
                <div className="form-field"><label>T-Shirt</label>
                  <input type="number" value={draft.uniforms.boys.tshirt} onChange={e => updateBoysUniform("tshirt", Number(e.target.value))} /></div>
                <div className="form-field"><label>Socks</label>
                  <input type="number" value={draft.uniforms.boys.socks} onChange={e => updateBoysUniform("socks", Number(e.target.value))} /></div>
                <div className="form-field"><label>Khaki Shorts</label>
                  <input type="number" value={draft.uniforms.boys.khakiShorts} onChange={e => updateBoysUniform("khakiShorts", Number(e.target.value))} /></div>
                <div className="form-field"><label>Green Shorts</label>
                  <input type="number" value={draft.uniforms.boys.greenShorts} onChange={e => updateBoysUniform("greenShorts", Number(e.target.value))} /></div>
                <div className="form-field"><label>Weekend Wear</label>
                  <input type="number" value={draft.uniforms.boys.weekend} onChange={e => updateBoysUniform("weekend", Number(e.target.value))} /></div>
              </div>

              <h4 style={{ margin: "1.5rem 0 .5rem", color: "var(--c-primary)" }}>Girls Uniform Pricing</h4>
              <div className="form-grid">
                <div className="form-field"><label>Sweater</label>
                  <input type="number" value={draft.uniforms.girls.sweater} onChange={e => updateGirlsUniform("sweater", Number(e.target.value))} /></div>
                <div className="form-field"><label>T-Shirt</label>
                  <input type="number" value={draft.uniforms.girls.tshirt} onChange={e => updateGirlsUniform("tshirt", Number(e.target.value))} /></div>
                <div className="form-field"><label>Socks</label>
                  <input type="number" value={draft.uniforms.girls.socks} onChange={e => updateGirlsUniform("socks", Number(e.target.value))} /></div>
                <div className="form-field"><label>Skirt</label>
                  <input type="number" value={draft.uniforms.girls.skirt} onChange={e => updateGirlsUniform("skirt", Number(e.target.value))} /></div>
                <div className="form-field"><label>Weekend Wear</label>
                  <input type="number" value={draft.uniforms.girls.weekend} onChange={e => updateGirlsUniform("weekend", Number(e.target.value))} /></div>
              </div>

            </div>

            <div className="form-actions" style={{ marginTop: "1.5rem" }}>
              <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={saveAll}>Save Master Fees</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
// ── Edit Student Modal (now includes transport toggle) ────────────────────────
function EditStudentModal({ student, onSave }: { student: Student; onSave: (s: Student) => void }) {
  const [open,     setOpen]     = useState(false);
  const [name,     setName]     = useState(student.name);
  const [guardian, setGuardian] = useState(student.guardian ?? "");
  const [phone,    setPhone]    = useState(student.phone ?? "");
  const [fees,     setFees]     = useState(String(student.expectedFees));
  const [type,     setType]     = useState<StudentType>(student.type);

  const submit = () => {
    if (!name.trim() || !Number(fees)) { toast.error("Name and fees required"); return; }
    onSave({ ...student, name: name.trim(), guardian: guardian.trim() || undefined, phone: phone.trim() || undefined, expectedFees: Number(fees), type });
    setOpen(false);
  };

  return (
    <>
      <button className="action-btn" onClick={() => {
        setOpen(true); setName(student.name); setGuardian(student.guardian ?? ""); setPhone(student.phone ?? "");
        setFees(String(student.expectedFees)); setType(student.type);
      }}>Edit</button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal modal--sm" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Edit Student</h3>
              <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="form-grid">
              <div className="form-field form-field--full"><label>Full Name</label><input value={name} onChange={e => setName(e.target.value)} /></div>
              <div className="form-field"><label>Guardian</label><input value={guardian} onChange={e => setGuardian(e.target.value)} /></div>
              <div className="form-field"><label>Phone</label><input value={phone} onChange={e => setPhone(e.target.value)} /></div>
              <div className="form-field form-field--full">
                <label>Student Type</label>
                <select className="bulk-select" value={type} onChange={e => setType(e.target.value as StudentType)}>
                  <option value="Day">Day Scholar</option>
                  <option value="Transport">Day + Transport</option>
                  <option value="Boarder">Boarder</option>
                </select>
              </div>
              <div className="form-field form-field--full"><label>Expected Fees (TZS)</label><input type="number" value={fees} onChange={e => setFees(e.target.value)} /></div>
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
                      <span className="student-row-meta">
  {s.type === 'Boarder' ? "🛏️ Boarder" : s.type === 'Transport' ? "🚌 Transport" : "🚶 Day"}
</span>
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
          <h1>Paradise Schools</h1>
          <h3>P.O BOX 94 Chato</h3>
          <p className="sub">Official Fee Receipt</p>
          <table><tbody>
            <tr><td>Receipt No.</td><td><span className="mono-cell">{tx.id.toUpperCase()}</span></td></tr>
            <tr><td>Date</td><td>{tx.date}</td></tr>
            {student && <tr><td>Student</td><td>{student.name}</td></tr>}
            {student && <tr><td>Class</td><td>{student.stream}</td></tr>}
            {student && <tr><td>Student Type</td><td>{student.type}</td></tr>}
            {student?.guardian && <tr><td>Guardian</td><td>{student.guardian}</td></tr>}
            <tr><td>Method</td><td>{tx.method}</td></tr>
            {tx.reference && <tr><td>Reference</td><td><span className="mono-cell">{tx.reference}</span></td></tr>}
            <tr><td>Received By</td><td>{tx.receivedBy}</td></tr>
            {tx.notes && <tr><td>Notes</td><td>{tx.notes}</td></tr>}
          </tbody></table>
          <hr />
          <table><tbody>
            <tr><td>Amount Paid</td><td><span className="amount">{fmt(tx.amount)}</span></td></tr>
            {student && <tr><td>Annual Fees</td><td>{fmt(student.expectedFees)}</td></tr>}
          </tbody></table>
          <p className="footer">Official receipt — retain for your records.<br />Paradise Schols · {CURRENT_TERM.label}</p>
        </div>
        <div className="form-actions">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={print}>Print Receipt</button>
        </div>
      </div>
    </div>
  );

}
// ═══════════════════════════════════════════════════════════════════════════════
// UNIFORM SALES (POINT OF SALE)
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Moved outside so React doesn't destroy and recreate it on every keystroke!
function ItemBtn({ 
  label, priceKey, category, globalFees, onAdd 
}: { 
  label: string; 
  priceKey: string; 
  category?: "boys" | "girls"; 
  globalFees: GlobalFees; 
  onAdd: (name: string, price: number) => void; 
}) {
  let price = 0;
  if (category === "boys") price = globalFees.uniforms.boys[priceKey as keyof typeof globalFees.uniforms.boys];
  else if (category === "girls") price = globalFees.uniforms.girls[priceKey as keyof typeof globalFees.uniforms.girls];
  else price = globalFees.uniforms[priceKey as keyof typeof globalFees.uniforms] as number;

  return (
    <button className="class-card" style={{ padding: "1rem", textAlign: "left" }} onClick={() => onAdd(label, price)}>
      <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{label}</div>
      <div style={{ color: "var(--c-primary)", fontSize: "0.85rem", marginTop: "4px" }}>{fmt(price)}</div>
    </button>
  );
}

// 2. The main page component
function UniformsPage({ globalFees, students, onRecord }: { 
  globalFees: GlobalFees; 
  students: Student[]; 
  onRecord: (t: Omit<Transaction, "id">) => void;
}) {
  const [studentId, setStudentId]         = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [method, setMethod]               = useState<PaymentMethod>("Cash");
  const [reference, setReference]         = useState("");
  const [cart, setCart]                   = useState<{ name: string; price: number; qty: number }[]>([]);

  // Filter students for the dropdown
  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    if (!q) return students.slice(0, 50); // Show first 50 if no search
    return students.filter(s => s.name.toLowerCase().includes(q)).slice(0, 50);
  }, [students, studentSearch]);

  const addToCart = (name: string, price: number) => {
    if (price <= 0) { toast.error("Price not set in Global Fees"); return; }
    setCart(prev => {
      const existing = prev.find(item => item.name === name);
      if (existing) return prev.map(item => item.name === name ? { ...item, qty: item.qty + 1 } : item);
      return [...prev, { name, price, qty: 1 }];
    });
  };

  const removeFromCart = (name: string) => {
    setCart(prev => prev.filter(item => item.name !== name));
  };

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);

  const handleCheckout = () => {
    if (!studentId) { toast.error("Please select a student"); return; }
    if (cart.length === 0) { toast.error("Cart is empty"); return; }

    const itemNames = cart.map(c => `${c.qty}x ${c.name}`).join(", ");
    
    onRecord({
      date: new Date().toISOString().slice(0, 10),
      studentId,
      amount: cartTotal,
      method,
      reference: reference || undefined,
      receivedBy: "Bursar",
      notes: `Uniform Sale: ${itemNames}`,
    });

    toast.success("Uniform sale recorded!");
    setCart([]);
    setStudentId("");
    setStudentSearch("");
    setReference("");
  };

  return (
    <div className="fade-in" style={{ display: "grid", gridTemplateColumns: "1fr 350px", gap: "1.5rem", alignItems: "start" }}>
      
      {/* LEFT: Item Selection */}
      <div>
        <div className="section-head"><h2 className="section-title">Uniform Items</h2></div>
        
        <h4 style={{ margin: "0 0 1rem", color: "var(--c-text-2)" }}>Full Sets</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "10px", marginBottom: "2rem" }}>
          <ItemBtn label="Full Uniform (Upper)" priceKey="fullUpper" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Full Uniform (Lower)" priceKey="fullLower" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Tracksuit" priceKey="tracksuit" globalFees={globalFees} onAdd={addToCart} />
        </div>

        <h4 style={{ margin: "0 0 1rem", color: "var(--c-text-2)" }}>Boys Individual Items</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "10px", marginBottom: "2rem" }}>
          <ItemBtn label="Sweater (Boys)" category="boys" priceKey="sweater" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="T-Shirt (Boys)" category="boys" priceKey="tshirt" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Socks (Boys)" category="boys" priceKey="socks" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Khaki Shorts" category="boys" priceKey="khakiShorts" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Green Shorts" category="boys" priceKey="greenShorts" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Weekend Wear" category="boys" priceKey="weekend" globalFees={globalFees} onAdd={addToCart} />
        </div>

        <h4 style={{ margin: "0 0 1rem", color: "var(--c-text-2)" }}>Girls Individual Items</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "10px" }}>
          <ItemBtn label="Sweater (Girls)" category="girls" priceKey="sweater" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="T-Shirt (Girls)" category="girls" priceKey="tshirt" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Socks (Girls)" category="girls" priceKey="socks" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Skirt" category="girls" priceKey="skirt" globalFees={globalFees} onAdd={addToCart} />
          <ItemBtn label="Weekend Wear" category="girls" priceKey="weekend" globalFees={globalFees} onAdd={addToCart} />
        </div>
      </div>

      {/* RIGHT: Cart & Checkout */}
      <div className="form-card" style={{ position: "sticky", top: "2rem" }}>
        <h3 style={{ margin: "0 0 1rem", borderBottom: "1px solid var(--c-border)", paddingBottom: "1rem" }}>Current Sale</h3>
        
        {/* Student Search */}
        <div className="form-field">
          <label>Select Student <span className="required">*</span></label>
          <input 
            placeholder="Search name..." 
            value={studentSearch} 
            onChange={e => { setStudentSearch(e.target.value); setStudentId(""); }}
            style={{ marginBottom: "0.5rem" }}
          />
          {studentSearch && !studentId && (
            <div className="student-list" style={{ maxHeight: "150px" }}>
              {filteredStudents.map(s => (
                <button key={s.id} className="student-row" onClick={() => { setStudentId(s.id); setStudentSearch(s.name); }}>
                  {s.name} <span className="student-row-meta">{s.stream}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Cart Items */}
        <div style={{ minHeight: "150px", margin: "1.5rem 0", padding: "1rem", background: "var(--c-bg)", borderRadius: "8px" }}>
          {cart.length === 0 ? (
            <div style={{ color: "var(--c-text-3)", textAlign: "center", marginTop: "3rem", fontSize: "0.9rem" }}>Cart is empty</div>
          ) : (
            cart.map((item, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem", fontSize: "0.9rem" }}>
                <div>
                  <span style={{ fontWeight: 600, marginRight: "8px" }}>{item.qty}x</span>
                  {item.name}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span>{fmt(item.price * item.qty)}</span>
                  <button onClick={() => removeFromCart(item.name)} style={{ background: "none", border: "none", color: "var(--c-danger)", cursor: "pointer" }}>✕</button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Checkout Controls */}
        <div className="form-grid">
          <div className="form-field">
            <label>Method</label>
            <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
              <option value="Cash">Cash</option><option value="Bank Transfer">Bank Transfer</option>
            </select>
          </div>
          {method === "Bank Transfer" && (
            <div className="form-field">
              <label>Reference</label>
              <input value={reference} onChange={e => setReference(e.target.value)} placeholder="Slip No..." />
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "1.2rem", fontWeight: 700, margin: "1.5rem 0 1rem" }}>
          <span>Total:</span>
          <span style={{ color: "var(--c-primary)" }}>{fmt(cartTotal)}</span>
        </div>

        <button 
          className="btn-primary" 
          style={{ width: "100%", padding: "0.75rem" }} 
          disabled={cart.length === 0 || !studentId}
          onClick={handleCheckout}
        >
          Complete Sale
        </button>
      </div>
    </div>
  );
}