-- Batch 53: runs first, before the migration, in the same transaction
-- (e2e/batch-53.spec.ts). Saves the Money position and every payout's
-- total as the Super Admin so e2e/sql/batch-53.sql can check the
-- migration changed nothing in money.
DO $before$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object(
    'sub', (SELECT id FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}')),
    'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text, true);
END
$before$;
CREATE TEMP TABLE t_pos0 AS SELECT money_position() AS p;
CREATE TEMP TABLE t_payouts0 AS
  SELECT p.id, p.total_amount, sum(i.delivery_charge + i.cod_fee + i.other_deduction) AS in_payout_kept
  FROM steadfast_payouts p JOIN steadfast_payout_items i ON i.payout_id = p.id
  GROUP BY p.id;
