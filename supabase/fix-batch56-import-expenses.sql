-- ============================================================
-- Batch 56 — Naeem's Kaarbar expenses into the site (one-time import)
-- ============================================================
-- Run ONCE in the Supabase SQL Editor. Batch 56 needs no migration and
-- does not depend on Batch 55.1.
--
-- What it does, in one transaction:
--   1. Stops with "Already done" (changing nothing) if these Kaarbar bills
--      are already on the site.
--   2. Makes WAHID and Riya Silva investors, unless an investor with that
--      name (or the same first name) is already there.
--   3. Adds the 97 rows of the Batch 56 preview (reports/batch-56.txt)
--      with the site's own importer, kaarbar_import_expenses() — exactly as
--      Money → Import from Kaarbar → Expenses would:
--        95 expenses, ৳220,969, all paid from Cash;
--        2 PROFIT SHARE rows as investor profit share:
--          WAHID ৳1,870, Riya Silva ৳3,800, from Cash.
--      Kaarbar categories that the site does not have yet are created by
--      the importer (as on the screen). Cash and the investors are found
--      by name here, not by ids copied from elsewhere.
--   4. Shows what was added and the Cash balance now.
--
-- It can be undone from the screen: Money → Import from Kaarbar →
-- Expenses → "Undo last import" (removes these entries and the categories
-- the import created; the two investors stay).
--
-- Expenses dated before the money start date (13 Nov 2026) are history:
-- they do not change Cash or any profit figure (your opening balances
-- already include them). Expenses from 13 Nov on lower Cash.
-- ============================================================

BEGIN;

-- The SQL Editor has no signed-in user: act as the Super Admin.
SELECT set_config('request.jwt.claims',
  (SELECT json_build_object('sub', p.id, 'role', 'authenticated', 'aal', 'aal2')::text
   FROM profiles p WHERE p.role = 'admin' AND p.status = 'approved'
   ORDER BY p.created_at, p.id LIMIT 1),
  true) IS NOT NULL AS acting_as_super_admin;

-- The importer also asks for the password typed again (within 5 minutes).
-- Running this in the Supabase SQL Editor is that confirmation.
SELECT set_config('request.jwt.claims',
  (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
   || jsonb_build_object('amr', jsonb_build_array(
        jsonb_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint))))::text,
  true) IS NOT NULL AS password_confirmed;

CREATE TEMP TABLE IF NOT EXISTS b56_result (import_id uuid, wahid uuid, riya uuid) ON COMMIT DROP;
TRUNCATE b56_result;

DO $import$
DECLARE
  -- The rows of the preview: Bill No, date, kind, Kaarbar category,
  -- account, investor, amount, Kaarbar note (exactly as in Kaarbar).
  c_rows constant jsonb := $rows$[
  {"bill_no":"97","date":"2026-11-17","kind":"expense","category":"Subscriptions (Ai / Services)","account":"Cash","party":null,"amount":2781,"note":"Claude AI"},
  {"bill_no":"96","date":"2026-11-15","kind":"expense","category":"Mobile Recharge","account":"Cash","party":null,"amount":300,"note":""},
  {"bill_no":"95","date":"2026-11-14","kind":"expense","category":"Shipping Cost","account":"Cash","party":null,"amount":635,"note":"Indian Cost (Mesbah)"},
  {"bill_no":"94","date":"2026-11-13","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":1700,"note":"Power Cable, Multi Plug"},
  {"bill_no":"93","date":"2026-10-11","kind":"expense","category":"Subscriptions (Ai / Services)","account":"Cash","party":null,"amount":1400,"note":"Karbar Subscriptions"},
  {"bill_no":"92","date":"2026-10-11","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":1500,"note":"Chocolate"},
  {"bill_no":"91","date":"2026-10-11","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":2545,"note":"Packaging"},
  {"bill_no":"80","date":"2026-10-10","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":130,"note":"Delivery Charge"},
  {"bill_no":"77","date":"2026-10-02","kind":"expense","category":"Salaries","account":"Cash","party":null,"amount":4000,"note":"Buds 4"},
  {"bill_no":"79","date":"2026-09-25","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":135,"note":"Delivery Charge Free"},
  {"bill_no":"78","date":"2026-09-24","kind":"expense","category":"Utilities","account":"Cash","party":null,"amount":200,"note":"Mobile Recharge"},
  {"bill_no":"76","date":"2026-09-20","kind":"expense","category":"Salaries","account":"Cash","party":null,"amount":4000,"note":"Buds 4"},
  {"bill_no":"75","date":"2026-09-16","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":153,"note":"Delivery Charge"},
  {"bill_no":"74","date":"2026-09-10","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":75,"note":"DC"},
  {"bill_no":"73","date":"2026-09-10","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":350,"note":"Oreo Busquets"},
  {"bill_no":"72","date":"2026-09-10","kind":"expense","category":"Subscriptions (Ai / Services)","account":"Cash","party":null,"amount":2800,"note":"Claude AI"},
  {"bill_no":"70","date":"2026-09-04","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":140,"note":"DC Free"},
  {"bill_no":"69","date":"2026-08-31","kind":"expense","category":"Food","account":"Cash","party":null,"amount":400,"note":"Mahmud"},
  {"bill_no":"68","date":"2026-08-28","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":200,"note":"Bank Fee"},
  {"bill_no":"67","date":"2026-08-28","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":150,"note":"COD FEE"},
  {"bill_no":"66","date":"2026-08-28","kind":"expense","category":"Salaries","account":"Cash","party":null,"amount":5000,"note":"Shopping + Movie"},
  {"bill_no":"65","date":"2026-08-24","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":210,"note":""},
  {"bill_no":"64","date":"2026-08-16","kind":"investor_profit_share","category":null,"account":"Cash","party":"WAHID","amount":1870,"note":"WAHID"},
  {"bill_no":"71","date":"2026-08-13","kind":"expense","category":"Subscriptions (Ai / Services)","account":"Cash","party":null,"amount":2800,"note":"Claude AI"},
  {"bill_no":"63","date":"2026-08-13","kind":"expense","category":"Gifts","account":"Cash","party":null,"amount":1200,"note":"ME SPIDER-MAN T SHIRT"},
  {"bill_no":"62","date":"2026-08-02","kind":"investor_profit_share","category":null,"account":"Cash","party":"Riya Silva","amount":3800,"note":"Riya Silva \nTotal Invest Amount - ৳50,000/-"},
  {"bill_no":"61","date":"2026-07-29","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":100,"note":"COD FEE"},
  {"bill_no":"60","date":"2026-07-28","kind":"expense","category":"Utilities","account":"Cash","party":null,"amount":100,"note":"Mobile Recharge"},
  {"bill_no":"59","date":"2026-07-27","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":1100,"note":"Chocolate"},
  {"bill_no":"58","date":"2026-07-27","kind":"expense","category":"Travel & Transportation","account":"Cash","party":null,"amount":200,"note":""},
  {"bill_no":"57","date":"2026-07-27","kind":"expense","category":"Food","account":"Cash","party":null,"amount":550,"note":"Maria Treat"},
  {"bill_no":"56","date":"2026-07-26","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":345,"note":"চকলেট"},
  {"bill_no":"55","date":"2026-07-24","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":140,"note":"Delivery Charge"},
  {"bill_no":"54","date":"2026-07-24","kind":"expense","category":"Food","account":"Cash","party":null,"amount":405,"note":"Asif Niloy BFC"},
  {"bill_no":"53","date":"2026-07-23","kind":"expense","category":"Food","account":"Cash","party":null,"amount":340,"note":"Raihan Treat"},
  {"bill_no":"52","date":"2026-07-23","kind":"expense","category":"Travel & Transportation","account":"Cash","party":null,"amount":440,"note":""},
  {"bill_no":"51","date":"2026-07-23","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":270,"note":"চকলেট"},
  {"bill_no":"85","date":"2026-07-22","kind":"expense","category":"Shipping Cost","account":"Cash","party":null,"amount":21411,"note":"18.3 KG - $ 237.9 - Raihan"},
  {"bill_no":"50","date":"2026-07-21","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":100,"note":"Staple Remover"},
  {"bill_no":"49","date":"2026-07-17","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":40,"note":"চকলেট"},
  {"bill_no":"48","date":"2026-07-16","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":80,"note":""},
  {"bill_no":"47","date":"2026-07-14","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":1180,"note":"Packaging 120p"},
  {"bill_no":"46","date":"2026-07-12","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":80,"note":"File Box"},
  {"bill_no":"45","date":"2026-07-11","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":120,"note":"DC"},
  {"bill_no":"44","date":"2026-07-11","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":180,"note":"chocolate"},
  {"bill_no":"43","date":"2026-07-11","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":300,"note":"Capcut"},
  {"bill_no":"42","date":"2026-07-11","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":360,"note":""},
  {"bill_no":"41","date":"2026-07-09","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":1400,"note":"Microphone"},
  {"bill_no":"40","date":"2026-07-09","kind":"expense","category":"Gifts","account":"Cash","party":null,"amount":310,"note":"DC + CHOCOLATE"},
  {"bill_no":"39","date":"2026-07-07","kind":"expense","category":"Travel & Transportation","account":"Cash","party":null,"amount":125,"note":""},
  {"bill_no":"38","date":"2026-07-07","kind":"expense","category":"Travel & Transportation","account":"Cash","party":null,"amount":400,"note":""},
  {"bill_no":"88","date":"2026-07-07","kind":"expense","category":"Other","account":"Cash","party":null,"amount":4101,"note":"Raihan Extra Pabe"},
  {"bill_no":"87","date":"2026-07-06","kind":"expense","category":"Service Charge","account":"Cash","party":null,"amount":8100,"note":"Raihan (Roky)"},
  {"bill_no":"84","date":"2026-07-06","kind":"expense","category":"Shipping Cost","account":"Cash","party":null,"amount":14625,"note":"12.5 KG - $ 162.5 - Roky"},
  {"bill_no":"37","date":"2026-06-27","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":1000,"note":"Pen drive"},
  {"bill_no":"36","date":"2026-06-24","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":3000,"note":"Curtains From Mahmud"},
  {"bill_no":"35","date":"2026-06-16","kind":"expense","category":"Gifts","account":"Cash","party":null,"amount":101,"note":"101 Taka will minus.\nCOD  46\nDC 55"},
  {"bill_no":"86","date":"2026-06-08","kind":"expense","category":"Service Charge","account":"Cash","party":null,"amount":2700,"note":"Raihan Taher (Tammat)"},
  {"bill_no":"83","date":"2026-06-08","kind":"expense","category":"Shipping Cost","account":"Cash","party":null,"amount":18000,"note":"15 KG - $ 200 - Tammat"},
  {"bill_no":"34","date":"2026-05-31","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":500,"note":""},
  {"bill_no":"82","date":"2026-05-18","kind":"expense","category":"Shipping Cost","account":"Cash","party":null,"amount":27000,"note":"25 KG - $ 300 - Junayed"},
  {"bill_no":"33","date":"2026-05-18","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":180,"note":"Gift + DC (Cumilla)"},
  {"bill_no":"32","date":"2026-05-14","kind":"expense","category":"Gifts","account":"Cash","party":null,"amount":4800,"note":"Jersey"},
  {"bill_no":"31","date":"2026-05-14","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":1860,"note":"Hand wash hexisol room freshener etc"},
  {"bill_no":"30","date":"2026-05-11","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":1000,"note":""},
  {"bill_no":"81","date":"2026-05-07","kind":"expense","category":"Shipping Cost","account":"Cash","party":null,"amount":42840,"note":"21 KG - $ 476 - BORDERLESS"},
  {"bill_no":"29","date":"2026-04-25","kind":"expense","category":"Food","account":"Cash","party":null,"amount":750,"note":"Treat Riya Gang"},
  {"bill_no":"28","date":"2026-04-24","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":500,"note":"A4 Sticker Papers 100pcs"},
  {"bill_no":"27","date":"2026-04-05","kind":"expense","category":"Gifts","account":"Cash","party":null,"amount":360,"note":"Delivery Charge Free"},
  {"bill_no":"26","date":"2026-04-05","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":1000,"note":"bKash Charges etc"},
  {"bill_no":"25","date":"2026-04-05","kind":"expense","category":"Gifts","account":"Cash","party":null,"amount":150,"note":"Sunscreen Sachet 10p"},
  {"bill_no":"89","date":"2026-04-01","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":2535,"note":"Tools and Tap"},
  {"bill_no":"90","date":"2026-03-31","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":476,"note":"Weight Scale"},
  {"bill_no":"24","date":"2026-03-24","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":1000,"note":""},
  {"bill_no":"23","date":"2026-03-05","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":130,"note":"Free Delivery Ananna"},
  {"bill_no":"22","date":"2026-03-04","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":130,"note":"Delivery Charge Free Atia Ratu"},
  {"bill_no":"21","date":"2026-02-07","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":100,"note":"bKash fee"},
  {"bill_no":"20","date":"2026-02-05","kind":"expense","category":"Customers Gifts / Disbursement / Offer","account":"Cash","party":null,"amount":300,"note":"Jarin and her mom DC free"},
  {"bill_no":"19","date":"2026-01-31","kind":"expense","category":"Repair & Maintenance","account":"Cash","party":null,"amount":70,"note":"Delivery Charge"},
  {"bill_no":"18","date":"2026-01-22","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":510,"note":"Packaging Sizes 30P"},
  {"bill_no":"17","date":"2026-01-09","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":30,"note":"Bank Loan Fee"},
  {"bill_no":"16","date":"2026-01-02","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":900,"note":"USB Extender - 250\nToner Cartridge - 600\nVara - 50"},
  {"bill_no":"14","date":"2025-12-31","kind":"expense","category":"Lost and Loss","account":"Cash","party":null,"amount":2600,"note":"Iteam Lost at airport"},
  {"bill_no":"13","date":"2025-12-29","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":540,"note":"Packaging 3 Sizes (50p)"},
  {"bill_no":"12","date":"2025-12-29","kind":"expense","category":"Materials","account":"Cash","party":null,"amount":430,"note":"A4 Paper"},
  {"bill_no":"11","date":"2025-11-28","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":36,"note":""},
  {"bill_no":"10","date":"2025-11-27","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":65,"note":""},
  {"bill_no":"9","date":"2025-11-26","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":180,"note":""},
  {"bill_no":"8","date":"2025-11-26","kind":"expense","category":"Travel & Transportation","account":"Cash","party":null,"amount":330,"note":""},
  {"bill_no":"7","date":"2025-11-23","kind":"expense","category":"Bank Fees","account":"Cash","party":null,"amount":20,"note":""},
  {"bill_no":"6","date":"2025-11-14","kind":"expense","category":"Travel & Transportation","account":"Cash","party":null,"amount":170,"note":""},
  {"bill_no":"5","date":"2025-11-14","kind":"expense","category":"Food","account":"Cash","party":null,"amount":720,"note":"Momo treat"},
  {"bill_no":"4","date":"2025-11-10","kind":"expense","category":"Food","account":"Cash","party":null,"amount":340,"note":""},
  {"bill_no":"3","date":"2025-11-10","kind":"expense","category":"Travel & Transportation","account":"Cash","party":null,"amount":210,"note":""},
  {"bill_no":"2","date":"2025-11-06","kind":"expense","category":"Gifts","account":"Cash","party":null,"amount":910,"note":"Raihan Gifts"},
  {"bill_no":"1","date":"2025-11-04","kind":"expense","category":"Other","account":"Cash","party":null,"amount":1720,"note":"Packaging, Paper Packet, Sticker Print, Tools, Delivery Charges, Bank Charge"},
  {"bill_no":"15","date":"2025-08-28","kind":"expense","category":"Shipping Cost","account":"Cash","party":null,"amount":11070,"note":"Travel Cost"}
]$rows$::jsonb;
  v_bills  text[];
  v_have   integer;
  v_cash   uuid;
  v_n      integer;
  v_wahid  uuid;
  v_riya   uuid;
  v_ids    uuid[];
  v_rows   jsonb;
  v_res    jsonb;
  r        record;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'No approved Super Admin was found to act as. Nothing was changed.';
  END IF;
  IF money_start_date() IS NULL THEN
    RAISE EXCEPTION 'Confirm your opening balances in Money first. Nothing was changed.';
  END IF;
  IF jsonb_array_length(c_rows) <> 97
     OR (SELECT sum((x ->> 'amount')::numeric) FROM jsonb_array_elements(c_rows) x) <> 226639 THEN
    RAISE EXCEPTION 'The rows in this file are not the 97 rows of the preview. Nothing was changed.';
  END IF;

  -- 1. Already done? (the importer's own mark: the Kaarbar Bill No)
  SELECT array_agg(x ->> 'bill_no') INTO v_bills FROM jsonb_array_elements(c_rows) x;
  SELECT count(*) INTO v_have FROM money_movements WHERE kaarbar_bill_no = ANY (v_bills);
  IF v_have = cardinality(v_bills) THEN
    RAISE EXCEPTION 'Already done: these % Kaarbar expenses are already on the site. Nothing was changed.', v_have;
  ELSIF v_have > 0 THEN
    RAISE EXCEPTION 'Stopped, nothing was changed: % of these % Kaarbar bills are already on the site (an import was done from the screen). Undo it there (Import from Kaarbar → Expenses → Undo last import), then run this file again.',
      v_have, cardinality(v_bills);
  END IF;

  -- The Cash account.
  SELECT count(*), min(id::text)::uuid INTO v_n, v_cash
  FROM money_accounts WHERE kind = 'cash' AND NOT archived AND lower(btrim(name)) = 'cash';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Found % open money accounts called "Cash" (expected 1). Nothing was changed.', v_n;
  END IF;

  -- 2. The two investors (never a second WAHID / Riya Silva).
  FOR r IN SELECT * FROM (VALUES ('WAHID', 'wahid', 'wahid'), ('Riya Silva', 'riyasilva', 'riya')) AS t (name, name_key, first_key) LOOP
    SELECT COALESCE(array_agg(id ORDER BY created_at), '{}') INTO v_ids FROM parties_payable
    WHERE kind = 'investor'
      AND (lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) = r.name_key
           OR lower(regexp_replace(split_part(btrim(name), ' ', 1), '[^A-Za-z]', '', 'g')) = r.first_key);
    IF cardinality(v_ids) > 1 THEN
      RAISE EXCEPTION 'More than one investor looks like "%": %. Nothing was changed.', r.name,
        (SELECT string_agg(name, ', ') FROM parties_payable WHERE id = ANY (v_ids));
    END IF;
    IF cardinality(v_ids) = 0 THEN
      IF EXISTS (SELECT 1 FROM parties_payable WHERE lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) = r.name_key) THEN
        RAISE EXCEPTION '"%" is already in Money as a person who is not an investor. Nothing was changed.', r.name;
      END IF;
      v_ids := ARRAY[money_save_party(NULL, r.name, NULL, 'investor', 'Investor (PROFIT SHARE rows from Kaarbar, Batch 56)')];
    END IF;
    IF r.name = 'WAHID' THEN v_wahid := v_ids[1]; ELSE v_riya := v_ids[1]; END IF;
  END LOOP;

  -- 3. The rows, with Cash and the investors filled in.
  SELECT jsonb_agg((x - 'account' - 'party') || jsonb_build_object(
           'account_id', v_cash,
           'party_id', CASE x ->> 'party' WHEN 'WAHID' THEN v_wahid WHEN 'Riya Silva' THEN v_riya END))
  INTO v_rows FROM jsonb_array_elements(c_rows) x;
  v_res := kaarbar_import_expenses(v_rows);
  IF (v_res ->> 'added')::integer <> 97 OR (v_res ->> 'total')::numeric <> 226639 THEN
    RAISE EXCEPTION 'Stopped, nothing was changed: the importer added % rows (৳%), not 97 (৳226639).',
      v_res ->> 'added', v_res ->> 'total';
  END IF;
  INSERT INTO b56_result VALUES ((v_res ->> 'import_id')::uuid, v_wahid, v_riya);
END;
$import$;

-- 4. What was added, and Cash now.
SELECT x.what, x.value
FROM b56_result b
CROSS JOIN LATERAL (VALUES
  (1, 'Rows added', (SELECT count(*)::text FROM money_movements WHERE kaarbar_import_id = b.import_id)),
  (2, 'Expenses', (SELECT format('%s rows, ৳%s', count(*), to_char(-sum(amount), 'FM999,999,990.00'))
                   FROM money_movements WHERE kaarbar_import_id = b.import_id AND type = 'expense')),
  (3, 'Profit share — WAHID', (SELECT format('৳%s', to_char(COALESCE(-sum(amount), 0), 'FM999,999,990.00'))
                   FROM money_movements WHERE kaarbar_import_id = b.import_id AND party_id = b.wahid)),
  (4, 'Profit share — Riya Silva', (SELECT format('৳%s', to_char(COALESCE(-sum(amount), 0), 'FM999,999,990.00'))
                   FROM money_movements WHERE kaarbar_import_id = b.import_id AND party_id = b.riya)),
  (5, 'Cash balance now', (SELECT format('৳%s', to_char(balance, 'FM999,999,990.00'))
                   FROM money_account_balances() WHERE kind = 'cash' AND NOT archived AND lower(btrim(name)) = 'cash'))
) AS x (n, what, value)
ORDER BY x.n;

COMMIT;
