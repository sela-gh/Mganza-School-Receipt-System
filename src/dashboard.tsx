import { useMemo, useState, useRef } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

// ─── Types ─────────────────────────────────────────────────────────────────────
type Stream = "PP1" | "PP2" | "Class 1" | "Class 2" | "Class 3" | "Class 4" | "Class 5" | "Class 6" | "Class 7";
const STREAMS: Stream[] = ["PP1", "PP2", "Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6", "Class 7"];
type TermFees = Record<Stream, number>;

const DEFAULT_FEES: TermFees = {
  "PP1": 12000, "PP2": 12000,
  "Class 1": 15000, "Class 2": 15000, "Class 3": 15000,
  "Class 4": 18000, "Class 5": 18000, "Class 6": 18000,
  "Class 7": 20000,
};

type Student = { id: string; name: string; stream: Stream; guardian?: string; expectedFees: number };
type PaymentMethod = "Bank Transfer" | "Cash";
type Transaction = { id: string; date: string; studentId: string; amount: number; method: PaymentMethod; reference?: string; receivedBy: string; notes?: string };
type Unallocated = { id: string; date: string; amount: number; method: PaymentMethod; reference?: string; depositorName?: string; reason: string };

// ─── Seed data ─────────────────────────────────────────────────────────────────
const seedStudents: Student[] = [
  { id: "s1",  name: "Amani Wanjiku",    stream: "PP1",     guardian: "Grace Wanjiku",  expectedFees: DEFAULT_FEES["PP1"] },
  { id: "s2",  name: "Brian Otieno",     stream: "PP2",     guardian: "Peter Otieno",   expectedFees: DEFAULT_FEES["PP2"] },
  { id: "s3",  name: "Cynthia Achieng",  stream: "Class 1", guardian: "Mary Achieng",   expectedFees: DEFAULT_FEES["Class 1"] },
  { id: "s4",  name: "Daniel Kiprop",    stream: "Class 2",                             expectedFees: DEFAULT_FEES["Class 2"] },
  { id: "s5",  name: "Esther Naliaka",   stream: "Class 3", guardian: "Rose Naliaka",   expectedFees: DEFAULT_FEES["Class 3"] },
  { id: "s6",  name: "Felix Mwangi",     stream: "Class 4",                             expectedFees: DEFAULT_FEES["Class 4"] },
  { id: "s7",  name: "Gloria Wambui",    stream: "Class 5", guardian: "Samuel Wambui",  expectedFees: DEFAULT_FEES["Class 5"] },
  { id: "s8",  name: "Henry Barasa",     stream: "Class 6",                             expectedFees: DEFAULT_FEES["Class 6"] },
  { id: "s9",  name: "Immaculate Njeri", stream: "Class 7", guardian: "Patrick Njeri",  expectedFees: DEFAULT_FEES["Class 7"] },
  { id: "s10", name: "James Kamau",      stream: "Class 1", guardian: "Lucy Kamau",     expectedFees: DEFAULT_FEES["Class 1"] },
];

const seedTransactions: Transaction[] = [
  { id: "t1", date: "2026-04-12", studentId: "s1",  amount: 8000,  method: "Bank Transfer", reference: "BNK-883421", receivedBy: "Bursar" },
  { id: "t2", date: "2026-04-15", studentId: "s3",  amount: 15000, method: "Cash",          receivedBy: "Bursar",    notes: "Cleared term 1" },
  { id: "t3", date: "2026-04-18", studentId: "s5",  amount: 10000, method: "Bank Transfer", reference: "BNK-884019", receivedBy: "Accountant" },
  { id: "t4", date: "2026-04-22", studentId: "s7",  amount: 18000, method: "Cash",          receivedBy: "Bursar" },
  { id: "t5", date: "2026-04-29", studentId: "s9",  amount: 12000, method: "Bank Transfer", reference: "BNK-885550", receivedBy: "Accountant" },
  { id: "t6", date: "2026-05-02", studentId: "s4",  amount: 7500,  method: "Cash",          receivedBy: "Bursar" },
  { id: "t7", date: "2026-05-04", studentId: "s8",  amount: 18000, method: "Bank Transfer", reference: "BNK-886112", receivedBy: "Accountant" },
];

const seedUnallocated: Unallocated[] = [
  { id: "u1", date: "2026-04-20", amount: 9000, method: "Bank Transfer", reference: "BNK-884201", depositorName: "Unknown depositor", reason: "Student name not indicated on slip" },
  { id: "u2", date: "2026-05-01", amount: 5000, method: "Bank Transfer", reference: "BNK-885888", depositorName: "M. Otieno", reason: "Deposit slip unreadable" },
];

const fmt = (n: number) =>
  new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", maximumFractionDigits: 0 }).format(n);
const uid = (p: string) => `${p}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

type Page = "overview" | "transactions" | "unallocated" | { type: "class"; stream: Stream };

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════════
export default function Dashboard() {
  const [termFees, setTermFees]         = useState<TermFees>(DEFAULT_FEES);
  const [students, setStudents]         = useState<Student[]>(seedStudents);
  const [transactions, setTransactions] = useState<Transaction[]>(seedTransactions);
  const [unallocated, setUnallocated]   = useState<Unallocated[]>(seedUnallocated);
  const [page, setPage]                 = useState<Page>("overview");
  const [receiptTx, setReceiptTx]       = useState<Transaction | null>(null);
  const [sidebarOpen, setSidebarOpen]   = useState(false);

  const studentLookup = useMemo(() => Object.fromEntries(students.map(s => [s.id, s])), [students]);

  const totals = useMemo(() => {
    const expected  = students.reduce((a, s) => a + s.expectedFees, 0);
    const collected = transactions.reduce((a, t) => a + t.amount, 0);
    return { expected, collected, debt: Math.max(0, expected - collected), unallocatedAmt: unallocated.reduce((a, u) => a + u.amount, 0) };
  }, [students, transactions, unallocated]);

  const streamStats = useMemo(() => STREAMS.map(stream => {
    const ss = students.filter(s => s.stream === stream);
    const exp = ss.reduce((a, s) => a + s.expectedFees, 0);
    const col = transactions.filter(t => ss.some(s => s.id === t.studentId)).reduce((a, t) => a + t.amount, 0);
    return { stream, count: ss.length, expected: exp, collected: col, debt: Math.max(0, exp - col) };
  }), [students, transactions]);

  // ── Mutators ────────────────────────────────────────────────────────────────
  const addStudent    = (s: Omit<Student, "id" | "expectedFees">) => {
    setStudents(p => [...p, { ...s, id: uid("s"), expectedFees: termFees[s.stream] }]);
    toast.success(`${s.name} enrolled in ${s.stream}`);
  };
  const editStudent   = (s: Student) => { setStudents(p => p.map(x => x.id === s.id ? s : x)); toast.success("Student updated"); };
  const removeStudent = (id: string) => { setStudents(p => p.filter(s => s.id !== id)); toast.success("Student removed"); };
  const moveStudent   = (id: string, to: Stream) => {
    setStudents(p => p.map(s => s.id === id ? { ...s, stream: to, expectedFees: termFees[to] } : s));
    toast.success("Student moved to " + to);
  };
  const updateFee     = (stream: Stream, amt: number) => {
    setTermFees(p => ({ ...p, [stream]: amt }));
    setStudents(p => p.map(s => s.stream === stream ? { ...s, expectedFees: amt } : s));
    toast.success(`${stream} fee updated`);
  };
  const recordTx = (t: Omit<Transaction, "id">) => {
    const tx = { ...t, id: uid("t") };
    setTransactions(p => [tx, ...p]);
    setReceiptTx(tx);
    toast.success("Payment recorded");
  };

  // ── Active class if applicable ───────────────────────────────────────────────
  const activeStream   = typeof page === "object" ? page.stream : null;
  const activeStudents = activeStream ? students.filter(s => s.stream === activeStream) : [];
  const activeTxs      = activeStream ? transactions.filter(t => activeStudents.some(s => s.id === t.studentId)) : [];

  return (
    <div className="app-shell">
      <Toaster richColors position="top-right" />
      {receiptTx && <ReceiptModal tx={receiptTx} student={studentLookup[receiptTx.studentId]} onClose={() => setReceiptTx(null)} />}

      {/* ── Mobile header ── */}
      <div className="mobile-header">
        <button className="burger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
          <span /><span /><span />
        </button>
        <span className="mobile-title">Madam Paradise</span>
        <RecordTxBtn students={students} onRecord={recordTx} />
      </div>

      {/* ── Sidebar overlay (mobile) ── */}
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      {/* ── Sidebar ── */}
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
          <NavItem icon="↔" label="Transactions" active={page === "transactions"}
            badge={transactions.length}
            onClick={() => { setPage("transactions"); setSidebarOpen(false); }} />
          <NavItem icon="◎" label="Unallocated" active={page === "unallocated"}
            badge={unallocated.length > 0 ? unallocated.length : undefined}
            badgeAlert
            onClick={() => { setPage("unallocated"); setSidebarOpen(false); }} />

          <div className="nav-section-label" style={{ marginTop: "1.5rem" }}>Classes</div>
          {STREAMS.map(stream => {
            const st = streamStats.find(s => s.stream === stream)!;
            const isActive = typeof page === "object" && page.stream === stream;
            return (
              <NavItem
                key={stream} icon="▸" label={stream}
                active={isActive}
                sub={`${st.count} students`}
                onClick={() => { setPage({ type: "class", stream }); setSidebarOpen(false); }}
              />
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="term-pill">Term 2 · 2026</div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className="main-area">
        {/* Top bar */}
        <header className="topbar">
          <div className="topbar-title">
            {page === "overview"      && "Overview"}
            {page === "transactions"  && "Transactions"}
            {page === "unallocated"   && "Unallocated Funds"}
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
          {/* ── OVERVIEW ── */}
          {page === "overview" && (
            <div className="fade-in">
              <div className="stat-grid">
                <StatCard label="Expected Revenue"  value={fmt(totals.expected)}       hint={`${students.length} students`} />
                <StatCard label="Total Collected"   value={fmt(totals.collected)}       accent="success" hint={`${Math.round((totals.collected / (totals.expected || 1)) * 100)}% collected`} />
                <StatCard label="Outstanding Debt"  value={fmt(totals.debt)}            accent="danger" />
                <StatCard label="Unallocated Funds" value={fmt(totals.unallocatedAmt)}  accent="warn" hint={`${unallocated.length} pending`} />
              </div>

              <div className="section-head">
                <h2 className="section-title">Classes</h2>
                <EditFeesModal termFees={termFees} onUpdate={updateFee} />
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
                      <div className="class-fee-label">Base fee {fmt(termFees[row.stream])}</div>
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

          {/* ── CLASS DETAIL ── */}
          {typeof page === "object" && (() => {
            const stream = page.stream;
            const stats  = streamStats.find(s => s.stream === stream)!;
            const classStudents = students.filter(s => s.stream === stream).map(s => {
              const paid    = transactions.filter(t => t.studentId === s.id).reduce((a, t) => a + t.amount, 0);
              const balance = Math.max(0, s.expectedFees - paid);
              return { ...s, paid, balance, status: (balance === 0 ? "cleared" : paid === 0 ? "unpaid" : "partial") as "cleared"|"partial"|"unpaid" };
            });
            const classTxs = transactions.filter(t => activeStudents.some(s => s.id === t.studentId));

            return (
              <div className="fade-in">
                <div className="stat-grid">
                  <StatCard label="Enrolled"    value={String(stats.count)} hint={`Base fee ${fmt(termFees[stream])}`} />
                  <StatCard label="Expected"    value={fmt(stats.expected)} />
                  <StatCard label="Collected"   value={fmt(stats.collected)} accent="success" hint={`${Math.round((stats.collected / (stats.expected || 1)) * 100)}%`} />
                  <StatCard label="Outstanding" value={fmt(stats.debt)} accent="danger" />
                </div>

                <div className="section-head">
                  <h2 className="section-title">Students — {stream}</h2>
                  <AddStudentModal defaultStream={stream} onAdd={addStudent} />
                </div>

                <div className="table-card">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>Guardian</th>
                        <th className="num">Expected</th>
                        <th className="num">Paid</th>
                        <th className="num">Balance</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {classStudents.map((s, i) => (
                        <tr key={s.id}>
                          <td className="row-num">{i + 1}</td>
                          <td className="name-cell">{s.name}</td>
                          <td className="muted-cell">{s.guardian ?? "—"}</td>
                          <td className="num">{fmt(s.expectedFees)}</td>
                          <td className="num">{fmt(s.paid)}</td>
                          <td className="num">{s.balance > 0 ? <span className="c-danger">{fmt(s.balance)}</span> : <span className="c-success">{fmt(0)}</span>}</td>
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
                        <tr><td colSpan={8} className="empty-row">No students enrolled in {stream} yet.</td></tr>
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

          {/* ── TRANSACTIONS ── */}
          {page === "transactions" && (
            <TransactionsPage
              transactions={transactions}
              studentLookup={studentLookup}
              onViewReceipt={setReceiptTx}
              students={students}
              onRecord={recordTx}
            />
          )}

          {/* ── UNALLOCATED ── */}
          {page === "unallocated" && (
            <UnallocatedPage
              entries={unallocated}
              students={students}
              onAdd={u => { setUnallocated(p => [{ ...u, id: uid("u") }, ...p]); toast.success("Entry logged"); }}
              onAllocate={(uid2, studentId) => {
                const u = unallocated.find(x => x.id === uid2)!;
                const tx: Transaction = { id: uid("t"), date: u.date, studentId, amount: u.amount, method: u.method, reference: u.reference, receivedBy: "Reallocated", notes: `Allocated from unallocated ${u.id}` };
                setTransactions(p => [tx, ...p]);
                setUnallocated(p => p.filter(x => x.id !== uid2));
                setReceiptTx(tx);
                toast.success("Funds allocated");
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function TransactionsPage({ transactions, studentLookup, onViewReceipt, students, onRecord }: {
  transactions: Transaction[];
  studentLookup: Record<string, Student>;
  onViewReceipt: (t: Transaction) => void;
  students: Student[];
  onRecord: (t: Omit<Transaction, "id">) => void;
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
      if (methodF !== "all" && t.method !== methodF) return false;
      if (from && t.date < from) return false;
      if (to   && t.date > to)   return false;
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
// UNALLOCATED PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function UnallocatedPage({ entries, students, onAdd, onAllocate }: {
  entries: Unallocated[];
  students: Student[];
  onAdd: (u: Omit<Unallocated, "id">) => void;
  onAllocate: (uid: string, studentId: string) => void;
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
        <button className="btn-primary" onClick={() => setShowForm(s => !s)}>
          {showForm ? "Cancel" : "+ Log Entry"}
        </button>
      </div>

      {showForm && (
        <div className="form-card">
          <div className="form-grid">
            <div className="form-field">
              <label>Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Amount (KES)</label>
              <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Method</label>
              <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
                <option value="Bank Transfer">Bank Transfer</option>
                <option value="Cash">Cash</option>
              </select>
            </div>
            <div className="form-field">
              <label>Reference / Slip</label>
              <input value={reference} onChange={e => setReference(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Depositor Name (if known)</label>
              <input value={depositorName} onChange={e => setDepositorName(e.target.value)} />
            </div>
            <div className="form-field form-field--full">
              <label>Reason <span className="required">*</span></label>
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
          <thead>
            <tr>
              <th>Date</th><th>Depositor</th><th>Method</th>
              <th>Reference</th><th>Reason</th>
              <th className="num">Amount</th><th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(u => (
              <tr key={u.id}>
                <td className="mono-cell">{u.date}</td>
                <td className="name-cell">{u.depositorName ?? "Unknown"}</td>
                <td><MethodBadge method={u.method} /></td>
                <td className="mono-cell">{u.reference ?? "—"}</td>
                <td className="muted-cell">{u.reason}</td>
                <td className="num bold-cell">{fmt(u.amount)}</td>
                <td>
                  <AllocateInline
                    entryId={u.id}
                    students={students}
                    onAllocate={studentId => onAllocate(u.id, studentId)}
                  />
                </td>
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
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════
function NavItem({ icon, label, active, badge, badgeAlert, sub, onClick }: {
  icon: string; label: string; active: boolean; badge?: number; badgeAlert?: boolean; sub?: string; onClick: () => void;
}) {
  return (
    <button className={`nav-item${active ? " nav-item--active" : ""}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">
        {label}
        {sub && <span className="nav-sub">{sub}</span>}
      </span>
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

function StatusBadge({ status }: { status: "cleared" | "partial" | "unpaid" }) {
  return <span className={`status-badge status-badge--${status}`}>{status}</span>;
}

function MethodBadge({ method }: { method: PaymentMethod }) {
  return <span className={`method-badge method-badge--${method === "Cash" ? "cash" : "bank"}`}>{method}</span>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORD TRANSACTION — class-first two-step picker
// ═══════════════════════════════════════════════════════════════════════════════
function RecordTxBtn({ students, onRecord }: { students: Student[]; onRecord: (t: Omit<Transaction, "id">) => void }) {
  const [open, setOpen]           = useState(false);

  // Step 1 — class picker
  const [selectedStream, setSelectedStream] = useState<Stream | "">("");

  // Step 2 — student + payment details
  const [studentId, setStudentId] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [amount, setAmount]       = useState("");
  const [method, setMethod]       = useState<PaymentMethod>("Cash");
  const [reference, setReference] = useState("");
  const [receivedBy, setReceivedBy] = useState("Bursar");
  const [date, setDate]           = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes]         = useState("");

  // Students filtered by selected stream + optional name search
  const streamStudents = useMemo(() => {
    if (!selectedStream) return [];
    const base = students.filter(s => s.stream === selectedStream);
    const q = studentSearch.trim().toLowerCase();
    return q ? base.filter(s => s.name.toLowerCase().includes(q)) : base;
  }, [students, selectedStream, studentSearch]);

  // When a student is picked, show their current balance as a hint
  const pickedStudent = students.find(s => s.id === studentId);

  const reset = () => {
    setSelectedStream(""); setStudentId(""); setStudentSearch("");
    setAmount(""); setReference(""); setNotes(""); setMethod("Cash");
    setReceivedBy("Bursar"); setDate(new Date().toISOString().slice(0, 10));
  };

  const close = () => { setOpen(false); reset(); };

  const submit = () => {
    const amt = Number(amount);
    if (!studentId)        { toast.error("Select a student"); return; }
    if (!amt || amt <= 0)  { toast.error("Enter a valid amount"); return; }
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

            {/* ── Step 1: Pick class ── */}
            <div className="step-block">
              <div className="step-label">
                <span className="step-num">1</span> Select Class
              </div>
              <div className="stream-picker">
                {STREAMS.map(s => (
                  <button
                    key={s}
                    className={`stream-chip${selectedStream === s ? " stream-chip--active" : ""}`}
                    onClick={() => { setSelectedStream(s); setStudentId(""); setStudentSearch(""); }}
                  >
                    {s}
                    <span className="chip-count">
                      {students.filter(st => st.stream === s).length}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* ── Step 2: Pick student from that class ── */}
            {selectedStream && (
              <div className="step-block">
                <div className="step-label">
                  <span className="step-num">2</span> Select Student — {selectedStream}
                </div>
                <input
                  className="student-search"
                  placeholder="Type to filter by name…"
                  value={studentSearch}
                  onChange={e => { setStudentSearch(e.target.value); setStudentId(""); }}
                  autoFocus
                />
                <div className="student-list">
                  {streamStudents.length === 0 && (
                    <div className="student-list-empty">
                      {studentSearch ? "No students match that name." : "No students in this class yet."}
                    </div>
                  )}
                  {streamStudents.map(s => (
                    <button
                      key={s.id}
                      className={`student-row${studentId === s.id ? " student-row--active" : ""}`}
                      onClick={() => setStudentId(s.id)}
                    >
                      <span className="student-row-name">{s.name}</span>
                      {s.guardian && <span className="student-row-guardian">Guardian: {s.guardian}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Step 3: Payment details ── */}
            {studentId && (
              <div className="step-block">
                <div className="step-label">
                  <span className="step-num">3</span> Payment Details
                  {pickedStudent && (
                    <span className="step-label-hint">for {pickedStudent.name}</span>
                  )}
                </div>
                <div className="form-grid">
                  <div className="form-field">
                    <label>Date</label>
                    <input type="date" value={date} onChange={e => setDate(e.target.value)} />
                  </div>
                  <div className="form-field">
                    <label>Amount (KES) <span className="required">*</span></label>
                    <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
                  </div>
                  <div className="form-field">
                    <label>Method</label>
                    <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
                      <option value="Cash">Cash</option>
                      <option value="Bank Transfer">Bank Transfer</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label>Received By</label>
                    <input value={receivedBy} onChange={e => setReceivedBy(e.target.value)} />
                  </div>
                  {method === "Bank Transfer" && (
                    <div className="form-field form-field--full">
                      <label>Bank Reference / Slip No.</label>
                      <input value={reference} onChange={e => setReference(e.target.value)} placeholder="e.g. BNK-884201" />
                    </div>
                  )}
                  <div className="form-field form-field--full">
                    <label>Notes <span className="optional">(optional)</span></label>
                    <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            <div className="form-actions">
              <button className="btn-ghost" onClick={close}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!studentId || !amount}
                onClick={submit}
              >
                Save &amp; Generate Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Add Student Modal ─────────────────────────────────────────────────────────
function AddStudentModal({ defaultStream, onAdd }: { defaultStream?: Stream; onAdd: (s: Omit<Student, "id" | "expectedFees">) => void }) {
  const [open, setOpen]         = useState(false);
  const [name, setName]         = useState("");
  const [stream, setStream]     = useState<Stream>(defaultStream ?? "PP1");
  const [guardian, setGuardian] = useState("");

  const submit = () => {
    if (!name.trim()) { toast.error("Enter student name"); return; }
    onAdd({ name: name.trim(), stream, guardian: guardian.trim() || undefined });
    setOpen(false); setName(""); setGuardian("");
  };

  return (
    <>
      <button className="btn-outline" onClick={() => setOpen(true)}>+ Add Student</button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal modal--sm" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Add Student</h3>
              <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="form-grid">
              <div className="form-field form-field--full">
                <label>Full Name <span className="required">*</span></label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Amani Wanjiku" />
              </div>
              <div className="form-field form-field--full">
                <label>Class</label>
                <select value={stream} onChange={e => setStream(e.target.value as Stream)}>
                  {STREAMS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-field form-field--full">
                <label>Guardian Name <span className="optional">(optional)</span></label>
                <input value={guardian} onChange={e => setGuardian(e.target.value)} />
              </div>
            </div>
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={submit}>Add Student</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Edit Student Modal ────────────────────────────────────────────────────────
function EditStudentModal({ student, onSave }: { student: Student; onSave: (s: Student) => void }) {
  const [open, setOpen]         = useState(false);
  const [name, setName]         = useState(student.name);
  const [guardian, setGuardian] = useState(student.guardian ?? "");
  const [fees, setFees]         = useState(String(student.expectedFees));

  const submit = () => {
    if (!name.trim() || !Number(fees)) { toast.error("Name and fees required"); return; }
    onSave({ ...student, name: name.trim(), guardian: guardian.trim() || undefined, expectedFees: Number(fees) });
    setOpen(false);
  };

  return (
    <>
      <button className="action-btn" onClick={() => { setOpen(true); setName(student.name); setGuardian(student.guardian ?? ""); setFees(String(student.expectedFees)); }}>Edit</button>
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
                <label>Expected Fees (KES)</label>
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

// ── Move Student Modal ────────────────────────────────────────────────────────
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

// ── Edit Fees Modal ───────────────────────────────────────────────────────────
function EditFeesModal({ termFees, onUpdate }: { termFees: TermFees; onUpdate: (s: Stream, v: number) => void }) {
  const [open, setOpen]     = useState(false);
  const [drafts, setDrafts] = useState<Record<Stream, string>>(() =>
    Object.fromEntries(STREAMS.map(s => [s, String(termFees[s])])) as Record<Stream, string>
  );

  const saveAll = () => {
    for (const s of STREAMS) {
      const v = Number(drafts[s]);
      if (!v || v <= 0) { toast.error(`Invalid fee for ${s}`); return; }
      onUpdate(s, v);
    }
    setOpen(false);
  };

  return (
    <>
      <button className="btn-outline" onClick={() => { setDrafts(Object.fromEntries(STREAMS.map(s => [s, String(termFees[s])])) as Record<Stream, string>); setOpen(true); }}>Edit Term Fees</button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal modal--sm" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Base Term Fees</h3>
              <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="fees-grid">
              {STREAMS.map(s => (
                <div key={s} className="fees-row">
                  <span className="fees-stream">{s}</span>
                  <input className="fees-input" type="number" value={drafts[s]} onChange={e => setDrafts(p => ({ ...p, [s]: e.target.value }))} />
                </div>
              ))}
            </div>
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={saveAll}>Save All</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Allocate Inline ───────────────────────────────────────────────────────────
function AllocateInline({ entryId, students, onAllocate }: { entryId: string; students: Student[]; onAllocate: (studentId: string) => void }) {
  const [open, setOpen]           = useState(false);
  const [selectedStream, setSelectedStream] = useState<Stream | "">("");
  const [studentSearch, setStudentSearch]   = useState("");
  const [studentId, setStudentId] = useState("");

  const streamStudents = useMemo(() => {
    if (!selectedStream) return [];
    const base = students.filter(s => s.stream === selectedStream);
    const q = studentSearch.trim().toLowerCase();
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
                    onClick={() => { setSelectedStream(s); setStudentId(""); setStudentSearch(""); }}>
                    {s}
                  </button>
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
                      {s.guardian && <span className="student-row-guardian">Guardian: {s.guardian}</span>}
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

// ── Receipt Modal ─────────────────────────────────────────────────────────────
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
          <p className="footer">Official receipt — retain for your records.<br />Madam Paradise School · Term 2, 2026</p>
        </div>
        <div className="form-actions">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={print}>🖨 Print Receipt</button>
        </div>
      </div>
    </div>
  );
}
