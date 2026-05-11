// ─────────────────────────────────────────────────────────────────────────────
// lib/supabase.ts
// Install:  npm install @supabase/supabase-js
// Add to your .env:
//   VITE_SUPABASE_URL=https://xxxx.supabase.co
//   VITE_SUPABASE_ANON_KEY=your-anon-key
// ─────────────────────────────────────────────────────────────────────────────
console.log("Testing Key:", import.meta.env.VITE_SUPABASE_ANON_KEY);
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─────────────────────────────────────────────────────────────────────────────
// Database row types  (mirrors the SQL schema exactly)
// ─────────────────────────────────────────────────────────────────────────────
export type PaymentMethod = "Cash" | "Bank Transfer";

export interface DbTerm {
  id:           string;
  name:         string;
  year:         number;
  term_number:  number;
  start_date:   string;
  end_date:     string;
  is_active:    boolean;
  created_at:   string;
}

export interface DbClass {
  id:         string;
  name:       string;
  sort_order: number;
  term_fees:  Record<string, number>;  // {"1":12000,"2":12000,"3":12000}
  created_at: string;
}

export interface DbStudent {
  id:         string;
  full_name:  string;
  class_id:   string;
  guardian:   string | null;
  is_active:  boolean;
  notes:      string | null;
  created_at: string;
  updated_at: string;
}

export interface DbStudentTermFee {
  id:           string;
  student_id:   string;
  term_id:      string;
  expected_fee: number;
  created_at:   string;
  updated_at:   string;
}

export interface DbTransaction {
  id:           string;
  student_id:   string;
  term_id:      string;
  payment_date: string;
  amount:       number;
  method:       PaymentMethod;
  reference:    string | null;
  received_by:  string;
  notes:        string | null;
  created_at:   string;
}

export interface DbUnallocatedFund {
  id:             string;
  term_id:        string;
  deposit_date:   string;
  amount:         number;
  method:         PaymentMethod;
  reference:      string | null;
  depositor_name: string | null;
  reason:         string;
  resolved:       boolean;
  resolved_tx_id: string | null;
  created_at:     string;
}

// View row types
export interface DbStudentBalance {
  student_id:   string;
  full_name:    string;
  guardian:     string | null;
  class_name:   string;
  class_order:  number;
  term_id:      string;
  term_name:    string;
  expected_fee: number;
  total_paid:   number;
  balance:      number;
  status:       "cleared" | "partial" | "unpaid";
}

export interface DbClassSummary {
  class_id:        string;
  class_name:      string;
  sort_order:      number;
  term_id:         string;
  term_name:       string;
  student_count:   number;
  total_expected:  number;
  total_collected: number;
  total_debt:      number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data-access functions — call these from your dashboard instead of using
// the local seed arrays.
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch the currently active term */
export async function getActiveTerm(): Promise<DbTerm | null> {
  const { data, error } = await supabase
    .from("terms")
    .select("*")
    .eq("is_active", true)
    .single();
  if (error) { console.error("getActiveTerm:", error); return null; }
  return data;
}

/** Fetch all classes ordered by sort_order */
export async function getClasses(): Promise<DbClass[]> {
  const { data, error } = await supabase
    .from("classes")
    .select("*")
    .order("sort_order");
  if (error) { console.error("getClasses:", error); return []; }
  return data ?? [];
}

/** Fetch all active students, optionally filtered by class */
export async function getStudents(classId?: string): Promise<DbStudent[]> {
  let query = supabase
    .from("students")
    .select("*")
    .eq("is_active", true)
    .order("full_name");
  if (classId) query = query.eq("class_id", classId);
  const { data, error } = await query;
  if (error) { console.error("getStudents:", error); return []; }
  return data ?? [];
}

/** Add a new student */
export async function addStudent(
  payload: Pick<DbStudent, "full_name" | "class_id" | "guardian">
): Promise<DbStudent | null> {
  const { data, error } = await supabase
    .from("students")
    .insert(payload)
    .select()
    .single();
  if (error) { console.error("addStudent:", error); return null; }
  return data;
}

/** Update a student */
export async function updateStudent(
  id: string,
  payload: Partial<Pick<DbStudent, "full_name" | "guardian" | "class_id" | "is_active" | "notes">>
): Promise<boolean> {
  const { error } = await supabase.from("students").update(payload).eq("id", id);
  if (error) { console.error("updateStudent:", error); return false; }
  return true;
}

/** Soft-delete a student */
export async function removeStudent(id: string): Promise<boolean> {
  return updateStudent(id, { is_active: false });
}

/** Fetch or create the expected fee for a student in a term */
export async function upsertStudentTermFee(
  studentId: string, termId: string, expectedFee: number
): Promise<boolean> {
  const { error } = await supabase
    .from("student_term_fees")
    .upsert({ student_id: studentId, term_id: termId, expected_fee: expectedFee },
             { onConflict: "student_id,term_id" });
  if (error) { console.error("upsertStudentTermFee:", error); return false; }
  return true;
}

/** Fetch all transactions for a term (optionally filtered by student) */
export async function getTransactions(termId: string, studentId?: string): Promise<DbTransaction[]> {
  let query = supabase
    .from("transactions")
    .select("*")
    .eq("term_id", termId)
    .order("payment_date", { ascending: false });
  if (studentId) query = query.eq("student_id", studentId);
  const { data, error } = await query;
  if (error) { console.error("getTransactions:", error); return []; }
  return data ?? [];
}

/** Record a new fee payment */
export async function recordTransaction(
  payload: Pick<DbTransaction, "student_id" | "term_id" | "payment_date" | "amount" | "method" | "received_by"> &
           Partial<Pick<DbTransaction, "reference" | "notes">>
): Promise<DbTransaction | null> {
  const { data, error } = await supabase
    .from("transactions")
    .insert(payload)
    .select()
    .single();
  if (error) { console.error("recordTransaction:", error); return null; }
  return data;
}

/** Fetch unallocated funds for a term */
export async function getUnallocatedFunds(termId: string): Promise<DbUnallocatedFund[]> {
  const { data, error } = await supabase
    .from("unallocated_funds")
    .select("*")
    .eq("term_id", termId)
    .eq("resolved", false)
    .order("deposit_date", { ascending: false });
  if (error) { console.error("getUnallocatedFunds:", error); return []; }
  return data ?? [];
}

/** Log a new unallocated fund entry */
export async function logUnallocatedFund(
  payload: Pick<DbUnallocatedFund, "term_id" | "deposit_date" | "amount" | "method" | "reason"> &
           Partial<Pick<DbUnallocatedFund, "reference" | "depositor_name">>
): Promise<DbUnallocatedFund | null> {
  const { data, error } = await supabase
    .from("unallocated_funds")
    .insert(payload)
    .select()
    .single();
  if (error) { console.error("logUnallocatedFund:", error); return null; }
  return data;
}

/**
 * Allocate an unallocated fund to a student.
 * Creates a transaction and marks the unallocated entry as resolved.
 * Done in two steps (Supabase doesn't support multi-statement RPC by default).
 */
export async function allocateFund(
  fundId: string,
  studentId: string,
  termId: string,
  fund: Pick<DbUnallocatedFund, "deposit_date" | "amount" | "method" | "reference">
): Promise<DbTransaction | null> {
  // 1. Create the transaction
  const tx = await recordTransaction({
    student_id:   studentId,
    term_id:      termId,
    payment_date: fund.deposit_date,
    amount:       fund.amount,
    method:       fund.method,
    reference:    fund.reference ?? undefined,
    received_by:  "Reallocated",
    notes:        `Allocated from unallocated fund ${fundId}`,
  });
  if (!tx) return null;

  // 2. Mark the unallocated entry resolved
  const { error } = await supabase
    .from("unallocated_funds")
    .update({ resolved: true, resolved_tx_id: tx.id })
    .eq("id", fundId);
  if (error) { console.error("allocateFund (resolve):", error); }

  return tx;
}

/** Fetch pre-aggregated student balances for a term (uses the view) */
export async function getStudentBalances(termId: string, classId?: string): Promise<DbStudentBalance[]> {
  let query = supabase
    .from("v_student_balances")
    .select("*")
    .eq("term_id", termId)
    .order("class_order")
    .order("full_name");
  if (classId) query = query.eq("class_name", classId); // or join on class_id if you expose it
  const { data, error } = await query;
  if (error) { console.error("getStudentBalances:", error); return []; }
  return data ?? [];
}

/** Fetch class collection summary for a term (uses the view) */
export async function getClassSummary(termId: string): Promise<DbClassSummary[]> {
  const { data, error } = await supabase
    .from("v_class_summary")
    .select("*")
    .eq("term_id", termId)
    .order("sort_order");
  if (error) { console.error("getClassSummary:", error); return []; }
  return data ?? [];
}

/** Update the base fee for a class and a given term number */
export async function updateClassFee(
  classId: string, termNumber: number, newFee: number
): Promise<boolean> {
  // Read current term_fees JSONB, update the key, write back
  const { data: cls, error: fetchErr } = await supabase
    .from("classes")
    .select("term_fees")
    .eq("id", classId)
    .single();
  if (fetchErr || !cls) { console.error("updateClassFee fetch:", fetchErr); return false; }

  const updated = { ...cls.term_fees, [String(termNumber)]: newFee };
  const { error } = await supabase
    .from("classes")
    .update({ term_fees: updated })
    .eq("id", classId);
  if (error) { console.error("updateClassFee save:", error); return false; }
  return true;
}
