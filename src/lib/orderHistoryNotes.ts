/**
 * Order-history notes the database's Steadfast functions used to write in
 * Bengali, shown in English (Batch 23 Part 6). Works before and after
 * supabase/migration-029-english-history-notes.sql is run — that migration
 * makes new and saved notes English at the source; this covers any row it
 * hasn't reached. Any other note (typed by Naeem) is shown as written.
 */
const ENGLISH_NOTES: Record<string, string> = {
  'Steadfast-এ পাঠানো হয়েছে': 'Sent to Steadfast',
  'Steadfast: ডেলিভারি সম্পন্ন হয়েছে': 'Steadfast: delivered',
  'Steadfast (auto): ডেলিভারি সম্পন্ন হয়েছে': 'Steadfast (auto): delivered',
};

export function orderHistoryNote(note: string): string {
  return ENGLISH_NOTES[note.trim()] ?? note;
}
