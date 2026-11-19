-- =====================================================================
-- Batch 53 — honest courier + COD fees in profit
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once.
--
-- What Steadfast gives per payout: amount (cash collected), charges (COD
-- fees), due_bills (delivery bills taken OUT of this payout), paid_bills
-- (delivery bills of parcels in this payout that were paid some other
-- way — NOT taken out of it) and total (= amount − charges − due_bills,
-- true for every stored payout). It never gives one parcel's bill.
--
-- A  Two new columns: bill_paid_separately (this parcel's share of
--    paid_bills: a real cost of its order, but not in the payout's cash)
--    and split_rule (which split wrote the numbers).
-- B  Backup copies of the payout lines and courier rows as they are now.
-- C  A guard: until the Steadfast functions are redeployed, the old code
--    may read a payout again — it must not undo the numbers below.
-- D  The numbers of every stored payout, worked out again by the Batch 53
--    split (the same code the Steadfast functions use): due_bills shared
--    over the parcels whose bill came out of the payout, paid_bills over
--    the parcels whose bill was paid separately, by zone. Every payout
--    still adds up to Steadfast's total to the paisa (checked).
-- E  order_courier_costs_for: the courier cost of each order and its
--    label — From Steadfast / Share of payout / Expected (delivered, no
--    payout yet) / No courier (hand delivery) / Not booked on Steadfast.
-- F  order_profit and inventory_sales_profit_core (Home, Money, Sales
--    profit and the reports) use it. Nothing else in them changes.
--
-- Money balances, "With Steadfast", payouts and payout totals do not
-- change: the money ledger reads only the part taken out of each payout,
-- and the payouts' totals are untouched.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------- A
ALTER TABLE public.steadfast_payout_items
  ADD COLUMN IF NOT EXISTS bill_paid_separately numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_rule text;
ALTER TABLE public.order_courier_costs
  ADD COLUMN IF NOT EXISTS bill_paid_separately numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_rule text;

-- ---------------------------------------------------------------- B
CREATE TABLE IF NOT EXISTS public._b53_backup_payout_lines AS
  SELECT id, payout_id, item_key, order_id, delivery_charge, cod_fee, other_deduction, net_paid, now() AS saved_at
  FROM public.steadfast_payout_items;
CREATE TABLE IF NOT EXISTS public._b53_backup_courier_costs AS
  SELECT order_id, payout_id, delivery_charge, cod_fee, other_deduction, total_kept, net_received, now() AS saved_at
  FROM public.order_courier_costs;
ALTER TABLE public._b53_backup_payout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._b53_backup_courier_costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._b53_backup_payout_lines, public._b53_backup_courier_costs FROM anon, authenticated;

-- ---------------------------------------------------------------- C
-- The new Steadfast code always sends split_rule = 'b53'. The old code
-- does not send it, so on a row recalculated here ('b53-backfill') the
-- value stays the same: then the recalculated money columns are kept.
CREATE OR REPLACE FUNCTION public.steadfast_split_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.split_rule = 'b53-backfill' AND NEW.split_rule IS NOT DISTINCT FROM OLD.split_rule THEN
    NEW.delivery_charge := OLD.delivery_charge;
    NEW.cod_fee := OLD.cod_fee;
    NEW.other_deduction := OLD.other_deduction;
    NEW.bill_paid_separately := OLD.bill_paid_separately;
    IF TG_TABLE_NAME = 'steadfast_payout_items' THEN
      NEW.net_paid := OLD.net_paid;
    ELSE
      NEW.total_kept := OLD.total_kept;
      NEW.net_received := OLD.net_received;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.steadfast_split_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS steadfast_payout_items_split_guard ON public.steadfast_payout_items;
CREATE TRIGGER steadfast_payout_items_split_guard
  BEFORE UPDATE ON public.steadfast_payout_items
  FOR EACH ROW EXECUTE FUNCTION public.steadfast_split_guard();

DROP TRIGGER IF EXISTS order_courier_costs_split_guard ON public.order_courier_costs;
CREATE TRIGGER order_courier_costs_split_guard
  BEFORE UPDATE ON public.order_courier_costs
  FOR EACH ROW EXECUTE FUNCTION public.steadfast_split_guard();

-- ---------------------------------------------------------------- D
-- Only the money columns change; the COD collected, matches, notes and
-- settled lines stay as they are ("payout.unsettle" tells the payout-line
-- guard of Batch 46/47 to leave every order's payments alone).
SELECT set_config('payout.unsettle', 'on', true);

UPDATE public.steadfast_payout_items i
SET delivery_charge = v.dc, cod_fee = v.fee, other_deduction = v.oth, net_paid = v.net,
    bill_paid_separately = v.sep, fee_estimated = true, split_rule = 'b53-backfill'
FROM (VALUES
  ('621e2699-9d79-451f-8bfe-ffdd22e695f7'::uuid, 0, 0, 0, 0, 80),
  ('e665927f-1403-49a0-93c3-8661601a0580'::uuid, 0, 0, 0, 0, 80),
  ('b78315f4-7fdc-4321-bda2-004efdb66362'::uuid, 0, 0, 0, 0, 80),
  ('f7c741bd-1038-4e22-a13f-fd876bb32433'::uuid, 0, 0, 0, 0, 80),
  ('ebe76256-8b78-432b-82e9-924b6b2d50e1'::uuid, 0, 0, 0, 0, 80),
  ('6b89b337-f1aa-420c-a2f8-3bf4029195ce'::uuid, 0, 0, 0, 0, 80),
  ('ae957e6a-61f9-4620-b409-d69191a8fd24'::uuid, 0, 0, 0, 0, 80),
  ('146ef742-26f3-4f52-b125-7dc5339c8815'::uuid, 0, 0, 0, 0, 80),
  ('c6859a25-170c-48f4-a99f-80300a01d60f'::uuid, 78.83, 0.29, 0, -19.12, 0),
  ('8e30723e-dda1-400c-ab6c-cefbf36f0e9e'::uuid, 0, 0, 0, 0, 80),
  ('fe4a12b8-4d3e-4c4f-896b-5235e723dedd'::uuid, 78.83, 0.49, 0, 20.68, 0),
  ('d1e4b23d-bbce-4a6e-86a8-69c1525d21c7'::uuid, 78.83, 0.34, 0, -9.17, 0),
  ('e94d6db8-62ca-4b3d-b388-4b5bedaac748'::uuid, 78.83, 0.49, 0, 20.68, 0),
  ('d019d3c0-17cf-4775-af24-75069142aa45'::uuid, 78.83, 0.05, 0, -68.88, 0),
  ('4deb09f0-5556-47bc-8e14-012afaa524af'::uuid, 0, 0, 0, 0, 80),
  ('21b6bd56-6950-4a8b-af17-a40a253fa9b8'::uuid, 0, 0, 0, 0, 80),
  ('2bca9702-3914-4ad6-afc2-04380bf01d93'::uuid, 0, 0, 0, 0, 80),
  ('da2f6794-2f4e-4e6f-ac1c-7230f389eab7'::uuid, 78.83, 0.34, 0, -9.17, 0),
  ('30fbb0b0-8372-463e-ac27-16c89744ab6e'::uuid, 78.82, 0.63, 0, 50.55, 0),
  ('82048610-e04c-4d85-98a4-e26e9b9fe87f'::uuid, 78.82, 0.63, 0, 50.55, 0),
  ('e934447c-c908-4ea9-848e-7aeb4b53f4ef'::uuid, 78.82, 0.34, 0, -9.16, 0),
  ('f7bd0198-23ce-4559-bdc0-32fed5cb83f2'::uuid, 78.82, 0.63, 0, 50.55, 0),
  ('a740b456-2751-4345-a841-af6e644463d4'::uuid, 78.82, 0.63, 0, 50.55, 0),
  ('35bc8edb-c6c9-4633-b791-d43226ebdad7'::uuid, 78.82, 0.34, 0, -9.16, 0),
  ('3cdc7d8c-52ff-40cb-977f-d023ddfa79dc'::uuid, 78.82, 0.53, 0, 30.65, 0),
  ('f317afcc-d42a-4be6-b64f-7f7927e438f5'::uuid, 0, 0, 0, 0, 80),
  ('39cebf15-5c94-4fdd-8e7e-5990ab5316c9'::uuid, 78.82, 0.53, 0, 30.65, 0),
  ('113fc5a9-a1e4-4ca7-bd19-424fb51703ce'::uuid, 0, 0, 0, 0, 80),
  ('fce2161d-bcdd-4552-bb50-2ea1c1cf3c5f'::uuid, 0, 0, 0, 0, 80),
  ('43348825-7905-49fd-a678-98b87b6b21f6'::uuid, 0, 0, 0, 0, 80),
  ('3a49e192-da40-4f5b-8cf4-27c9365743c3'::uuid, 78.82, 0, 0, -78.82, 0),
  ('4e1eca5a-0816-40e5-b0d9-32effcc273a9'::uuid, 78.82, 0.34, 0, -9.16, 0),
  ('c752f099-886a-417a-a515-aea5b00d8b5b'::uuid, 78.82, 6.4, 0, 1234.78, 0),
  ('58f6fe75-b186-4bd2-b84a-e0046a5a8048'::uuid, 0, 0, 0, 0, 93.34),
  ('8bdc01e7-9050-4567-8658-1b8c9448b56c'::uuid, 0, 16, 0, 1614, 93.33),
  ('094bfbf7-3d5c-48bd-8e49-225bb6bbcc29'::uuid, 0, 0, 0, 0, 93.33),
  ('48e8ebc9-cbee-4891-a780-275456e5ea8f'::uuid, 0, 0.69, 0, 69.31, 60),
  ('2204f864-211b-465f-a34f-3988dba5e0e6'::uuid, 60, 63.31, 0, 6256.69, 0),
  ('1bdf53d4-63b5-4508-b406-56ddfbef0da5'::uuid, 0, 0, 0, 0, 81.67),
  ('d74e7851-ac60-41cb-9dd2-26d2143c47ee'::uuid, 0, 0, 0, 0, 81.67),
  ('411935ce-3988-4025-8d7b-cfd9e28cd149'::uuid, 0, 0, 0, 0, 81.67),
  ('80f3101f-26de-4d02-b3fc-521c02b4a7d6'::uuid, 0, 0, 0, 0, 81.67),
  ('8d8a4af6-365f-4c76-a5ab-7db59471ffef'::uuid, 0, 0, 0, 0, 81.66),
  ('695f402b-6d7c-4e96-857b-b9f164c05e74'::uuid, 0, 16, 0, 1534, 81.66),
  ('3b7d9861-4df5-4abe-987d-5f73c20d8fea'::uuid, 0, 0, 0, 0, 96),
  ('3822473c-1342-4c59-b2a5-1cce21063826'::uuid, 0, 0, 0, 0, 96),
  ('9bfccfb6-db8f-4edd-95af-2582ee2f4bae'::uuid, 0, 0, 0, 0, 96),
  ('ba8f4201-0370-487a-9614-bbe882da4522'::uuid, 0, 0, 0, 0, 96),
  ('fac23011-0744-4b8f-ad04-6cf933d0acab'::uuid, 0, 40, 0, 3990, 96),
  ('2f195835-9c79-4541-80b6-d60b26df107a'::uuid, 0, 25, 0, 2475, 110),
  ('e4989676-fa5a-4afd-98e0-e118ddc98356'::uuid, 0, 0, 0, 0, 52.5),
  ('1c7ed0b0-4f0f-4845-adc9-27d688b7d776'::uuid, 0, 22, 0, 2128, 52.5),
  ('68eac4f9-7b10-4f86-8cdc-bfa943d084cd'::uuid, 0, 0, 0, 0, 117.5),
  ('2f8b0e6d-fac0-442b-b7f3-f247425f7e3f'::uuid, 0, 0, 0, 0, 117.5),
  ('dd81429d-a45a-460d-9e31-ac961221f645'::uuid, 140, 2.67, 0, 162.33, 0),
  ('73e29595-e002-4eb4-8e03-1e967d44c7f5'::uuid, 140, 0, 0, -140, 0),
  ('75fb031c-ae25-48d1-acc6-37daf092bfb8'::uuid, 140, 29.33, 0, 3180.67, 0),
  ('7041aa3e-4c23-4157-bc0c-bb72f88e585e'::uuid, 0, 61, 0, 6079, 105),
  ('e372b134-054d-4c2b-95c7-988d2d536b6e'::uuid, 0, 0, 0, 0, 105),
  ('b248640b-fc47-4050-bbc0-5ab137fee6fc'::uuid, 0, 0, 0, 0, 105),
  ('3ab5939f-fa31-4e74-9e06-4d32476d6143'::uuid, 0, 0, 0, 0, 105),
  ('4e02b7d5-9652-4855-8d9e-05cc0708819e'::uuid, 0, 0, 0, 0, 141.67),
  ('1372c1e0-4c06-419e-8b42-79fdda41cb60'::uuid, 115, 1.1, 0, 3.9, 0),
  ('81baa9ca-5959-4b4d-948d-30e237d6ebb0'::uuid, 115, 20.9, 0, 2134.1, 0),
  ('a8d51f35-6aee-4a89-b6ff-f8c28e932d7e'::uuid, 0, 0, 0, 0, 141.67),
  ('b5a9fd18-e289-4275-a774-81ea047743c8'::uuid, 0, 0, 0, 0, 141.66),
  ('d24fceb1-1f4f-4908-9790-c32ffb7930f4'::uuid, 0, 0, 0, 0, 115),
  ('647360f4-8fe6-4a6f-8ca5-532612993027'::uuid, 0, 0, 0, 0, 115),
  ('938ca2ad-5318-4e68-b6e0-ad91c635043b'::uuid, 55, 12, 0, 1223, 0),
  ('d4546bcd-d51a-45fd-9b0e-d211874c9ff4'::uuid, 85, 1.15, 0, 33.85, 0),
  ('d27348dc-0576-4614-a82e-4c93b28f4ab6'::uuid, 85, 44.85, 0, 4570.15, 0),
  ('70978e56-b874-4934-9dfb-df22d6c94b99'::uuid, 90, 0.89, 0, 9.11, 0),
  ('b45715d3-7263-4dd4-87c9-5c2cd1b7c706'::uuid, 90, 14.11, 0, 1475.89, 0),
  ('282f5c5e-712c-4491-abf9-158c967d0246'::uuid, 95, 0, 0, -95, 0),
  ('dfd51cb7-18d1-4aae-80a1-d86b544e95db'::uuid, 95, 47.47, 0, 4947.53, 0),
  ('7f9bfdb2-7a0c-4211-ad6e-f78d1dcadb50'::uuid, 95, 0, 0, -95, 0),
  ('5d0c6752-49bf-47f9-b20d-11bd3fd14613'::uuid, 95, 27.98, 0, 2877.02, 0),
  ('8c0b3a53-72fb-4805-9fcf-258b76a97b14'::uuid, 95, 6.25, 0, 568.75, 0),
  ('0ee8ab6a-8cca-477f-8be1-6856fe59c6fd'::uuid, 95, 6.81, 0, 628.19, 0),
  ('c0dffe72-2146-4ad7-8444-da735919f7f9'::uuid, 95, 6.81, 0, 628.19, 0),
  ('4620cb7b-89f6-4152-b645-cf2e83d25da7'::uuid, 95, 13.71, 0, 1361.29, 0),
  ('a3dc6eb6-14a3-4beb-a98c-e0cd9dba7cb3'::uuid, 95, 6.81, 0, 628.19, 0),
  ('fa894f88-8383-4d11-ac76-5c41d7f152f1'::uuid, 95, 6.25, 0, 568.75, 0),
  ('fb4e71f5-04cf-4a96-afe9-7788732e4bb8'::uuid, 95, 10.91, 0, 1064.09, 0),
  ('4887668f-f88f-42ec-9ec7-ef994c17be07'::uuid, 80.72, 6.8, 0, 642.48, 0),
  ('a33934a7-f571-4df7-862d-00daf205b394'::uuid, 80.72, 5.12, 0, 464.16, 0),
  ('04dcd3c6-2281-4adf-83b0-0e2a7ced0e05'::uuid, 80.72, 6.7, 0, 632.58, 0),
  ('38820b70-007e-4d8e-aca7-cad614b2c5b7'::uuid, 80.71, 6.24, 0, 583.05, 0),
  ('8eab2438-d97e-4536-a65b-6dc4a390885c'::uuid, 80.71, 0.65, 0, -11.36, 0),
  ('b05ea59d-fc9d-47f0-acca-30d6f78783a4'::uuid, 80.71, 19.09, 0, 1950.2, 0),
  ('b7c6e125-9807-4ddd-8cc3-419dbc0f8e47'::uuid, 80.71, 24.4, 0, 2514.89, 0),
  ('a5ca069d-e9d0-4cb7-943e-7a8a46012de7'::uuid, 0, 0, 0, 0, 85),
  ('4d9bbee9-4cbc-4006-8c12-ad27608ac93a'::uuid, 0, 0, 0, 0, 85),
  ('45ea3855-20ae-458d-a1e0-989212396a85'::uuid, 101.25, 12.69, 0, 1216.06, 0),
  ('aa563c72-3c32-42c7-b0c1-120bc2e7f655'::uuid, 101.25, 25.96, 0, 2592.79, 0),
  ('ec143566-a1e0-4b55-aac1-8dbfd4e9c1cf'::uuid, 101.25, 20.81, 0, 2057.94, 0),
  ('fe2a2967-35a2-4d12-a088-3938a9a1bdac'::uuid, 101.25, 21.76, 0, 2156.99, 0),
  ('f5225902-a979-4d47-a016-14d67885e709'::uuid, 0, 0, 0, 0, 85),
  ('f9e00fc1-f7e4-470d-af47-0e31b9d3a61f'::uuid, 101.25, 53.16, 0, 5415.59, 0),
  ('113f577e-8074-4950-80b6-33b907a335a0'::uuid, 101.25, 0.67, 0, -31.92, 0),
  ('e59bc584-5358-4493-8fc5-aa0c3eb1638b'::uuid, 101.25, 20.8, 0, 2057.95, 0),
  ('80e7347b-e022-45ae-ae5d-e44c6bd77ae8'::uuid, 101.25, 24.15, 0, 2404.6, 0),
  ('32793696-85e2-47d1-95ec-2f772f0f2316'::uuid, 0, 0, 0, 0, 55),
  ('9ec301d7-911e-4919-a082-ea6954cc4403'::uuid, 65, 32, 0, 3173, 0),
  ('4bc06afb-e2e7-4d9a-bbe1-2fe563715f17'::uuid, 65, 35, 0, 3470, 0),
  ('d2d51c2d-9cae-498d-a0a1-35a0b373db6c'::uuid, 0, 0, 0, 0, 57.5),
  ('fe96b2a3-032e-43db-a692-eefc8869e0f6'::uuid, 61.67, 0.45, 0, -2.12, 0),
  ('92a4a354-1787-467a-be86-31932b1c30b8'::uuid, 61.67, 4.98, 0, 593.35, 0),
  ('34124b7e-6508-4ab2-b792-778e05b70fb2'::uuid, 61.66, 0.57, 0, 12.77, 0),
  ('53dea567-1a44-4bdc-96e3-7f697756f70f'::uuid, 0, 0, 0, 0, 57.5),
  ('c3a91c9e-84d0-44f4-bc0c-1de3b785c1fc'::uuid, 0, 0, 0, 0, 98.75),
  ('fb4ce313-9867-4fec-ad1d-0df9d6216cf2'::uuid, 0, 0, 0, 0, 98.75),
  ('13612708-b4bd-4ca3-baf7-0111f6d4cfd4'::uuid, 0, 0, 0, 0, 98.75),
  ('fa425dbd-22cf-4a18-bc19-ca8c282be085'::uuid, 65, 12, 0, 1193, 0),
  ('1be14793-ff70-4326-87fb-d295a2b69002'::uuid, 0, 0, 0, 0, 98.75),
  ('93a2e7f5-caee-4315-997d-13f249cfa5db'::uuid, 108.34, 23.17, 0, 2288.49, 0),
  ('8cf586f0-038c-479d-9f29-9056ca395dec'::uuid, 0, 0, 0, 0, 95),
  ('c5ac4ed9-078c-416c-88e8-cd9cffa9faef'::uuid, 108.33, 0, 0, -108.33, 0),
  ('fdd0988d-e90c-4e17-a231-3f31e0de8c16'::uuid, 108.33, 32.83, 0, 3288.84, 0),
  ('41392368-57b9-4446-b6e0-8033b7dbd56c'::uuid, 76.67, 0.61, 0, -7.28, 0),
  ('3a87e078-0779-43a2-8e9a-941a9f802f4b'::uuid, 0, 0, 0, 0, 78.34),
  ('d96d7a59-c6b7-4703-a9d2-31d4c7a72594'::uuid, 76.67, 5.8, 0, 587.53, 0),
  ('c53ac586-499c-47ee-9121-8b53491ca054'::uuid, 0, 0, 0, 0, 78.33),
  ('9c8263ba-5436-485e-b561-0648084c405c'::uuid, 0, 0, 0, 0, 78.33),
  ('454023e3-385b-41fa-acc3-992f846d6044'::uuid, 76.67, 1.21, 0, 62.12, 0),
  ('1f536f6c-e4fd-4c0d-8899-b2bf7ca0e75e'::uuid, 76.67, 0, 0, -76.67, 0),
  ('03ce917f-ae0b-4f4e-9bdd-70cd32025622'::uuid, 76.66, 0, 0, -76.66, 0),
  ('ed5daf6a-fed8-439f-8541-e4017968d3e9'::uuid, 76.66, 21.38, 0, 2371.96, 0),
  ('315eeb71-42e7-4196-a0b0-50af65fa7d5a'::uuid, 0, 0, 0, 0, 70),
  ('a72ee098-5073-4379-8856-01ee2ebda882'::uuid, 115, 28, 0, 2787, 0),
  ('746a54b8-b57b-446a-bd98-44c83ff77842'::uuid, 0, 0, 0, 0, 70),
  ('51bc547e-0e0b-4826-ab96-883c69e5f518'::uuid, 83, 29.04, 0, 2867.96, 0),
  ('3c65d77a-831c-48b0-aecb-732b89ad2827'::uuid, 83, 42.1, 0, 4194.9, 0),
  ('3f3da9e6-76bb-4bc3-91eb-10730bf66a9d'::uuid, 83, 44.54, 0, 4442.46, 0),
  ('7b6a3280-769f-49b0-91bc-14ed6f01fae2'::uuid, 83, 22.8, 0, 2234.2, 0),
  ('11b9ca83-235c-40f1-96de-5d27a05cd4c9'::uuid, 83, 14.52, 0, 1392.48, 0),
  ('7c43a4b8-fa3d-4396-a73d-d7c99656e42d'::uuid, 0, 0, 0, 0, 110),
  ('a21d9aad-47d9-467d-b520-2556d1bc53f4'::uuid, 0, 0, 0, 0, 110),
  ('4d57f6cd-16bf-49a5-a27c-fca9084c1f43'::uuid, 120, 0, 0, -120, 0),
  ('f0e7f0c7-6db0-4c7b-bf5e-f9dccb2d979c'::uuid, 120, 27, 0, 2753, 0),
  ('20be7d5d-e71e-403a-8c6b-83f9b156f797'::uuid, 0, 0, 0, 0, 55),
  ('ba375268-a14b-4576-bcc9-f04c183ddf68'::uuid, 115, 21, 0, 2044, 0),
  ('e809e718-0cba-4926-953c-03df21f61452'::uuid, 123.5, 20.91, 0, 2035.59, 0),
  ('5b034c8c-c087-4450-98c3-1f19a2541ebd'::uuid, 0, 0, 0, 0, 123.5),
  ('4035481b-d8df-4d15-9986-353b9ccac94e'::uuid, 123.5, 14.68, 0, 1391.82, 0),
  ('8ee78d83-fb1f-47db-a722-d100505444c6'::uuid, 0, 0, 0, 0, 95),
  ('931ddae1-cbc6-4b9a-bdc2-489b1fa2ecbe'::uuid, 0, 0, 0, 0, 66.5),
  ('fd2fe6e9-f085-4161-bb63-f38119a545ac'::uuid, 0, 0, 0, 0, 66.5),
  ('47716f00-075f-43f1-a28d-d70bceb772b7'::uuid, 0, 0, 0, 0, 123.5),
  ('23662f3a-fe35-490b-b5ce-17b3d76c150e'::uuid, 66.5, 29.45, 0, 2974.05, 0),
  ('b960cd16-7c95-4c60-b244-590c2152f191'::uuid, 66.5, 20.24, 0, 2023.26, 0),
  ('cee685e6-e457-4a44-9e22-27f5c0b557dd'::uuid, 95, 13.72, 0, 1321.28, 0),
  ('78f054eb-68a9-40e2-ab6e-0cae24f65091'::uuid, 0, 0, 0, 0, 115),
  ('c2dfbdf5-3a77-41fe-b7df-ddcf04f0c0d9'::uuid, 115, 51, 0, 5043, 0),
  ('b1e36c5e-8114-41cc-aabe-d44e935cecb3'::uuid, 108.34, 22.82, 0, 2247.84, 0),
  ('d68b989a-e4c2-46c9-a73e-5b0f802f6988'::uuid, 108.33, 21.77, 0, 2139.9, 0),
  ('12910db9-0f8e-4328-8e00-a5a6d051054b'::uuid, 91.67, 0, 0, -91.67, 0),
  ('d7d70e43-39d4-4459-a70c-5c01ef30b446'::uuid, 0, 0, 0, 0, 65),
  ('a0446aa5-eafd-4a94-ad2e-68060c423e1a'::uuid, 108.33, 39.13, 0, 3931.54, 0),
  ('2d6ad8d1-5e35-464a-816e-f1b3541e636f'::uuid, 108.33, 0, 0, -108.33, 0),
  ('f43b84d2-1e9c-4f03-bcf1-01c0a561156d'::uuid, 0, 33.28, 0, 3435.72, 65),
  ('87219ba5-a7e5-4431-8113-4aa7554fc715'::uuid, 105, 8, 0, 787, 0),
  ('0578e810-9749-42d0-975c-568ddd6d036d'::uuid, 0, 0, 0, 0, 115),
  ('df031cd0-51b2-44bf-8747-79d1024fe630'::uuid, 135, 88, 0, 8707, 0),
  ('1f8ddda2-3680-4d0a-a442-589c3b3778e4'::uuid, 55, 11, 0, 1084, 0),
  ('211d28b3-f98a-49fe-9f1e-613667ad618b'::uuid, 0, 0, 0, 0, 65),
  ('dbe3f842-9800-40b2-957a-f7ae4a233d85'::uuid, 110.5, 0, 0, -110.5, 0),
  ('1cb5b13e-af1f-4ce4-abfe-d09f050422e9'::uuid, 59.5, 21, 0, 2039.5, 0),
  ('ca06cdb1-f61d-4e9b-9ac8-b37763ecc242'::uuid, 110, 14, 0, 1476, 0),
  ('30ad8a3b-c61a-40e4-b1fc-d798453191b2'::uuid, 110, 0, 0, -110, 0),
  ('0899da6f-5226-47f1-9609-8c5298c79ef8'::uuid, 0, 0, 0, 0, 65),
  ('c5dcada4-ecff-4e8a-b82c-56ec94463c1b'::uuid, 105, 9, 0, 886, 0)
) AS v (id, dc, fee, oth, net, sep)
WHERE i.id = v.id;

UPDATE public.order_courier_costs c
SET delivery_charge = v.dc, cod_fee = v.fee, other_deduction = v.oth, bill_paid_separately = v.sep,
    total_kept = v.kept, net_received = v.net, split_rule = 'b53-backfill', updated_at = now()
FROM (VALUES
  ('de6f7b45-4842-4dd7-b77f-3140d077cd68'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 123.5, 20.91, 0, 0, 144.41, 2035.59),
  ('26a9f667-5e75-429c-913c-907710d6a09b'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 0, 0, 0, 123.5, 123.5, 0),
  ('33b4a257-93fc-480e-84b3-e5a7dccb7876'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 123.5, 14.68, 0, 0, 138.18, 1391.82),
  ('540f8471-4c5f-4d1a-928c-49ce0d05fa7f'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 0, 0, 0, 66.5, 66.5, 0),
  ('755c8c1c-7ccf-4249-a42c-c6cbb8e8903f'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 0, 0, 0, 66.5, 66.5, 0),
  ('b47bf52a-1a38-47bf-9229-06b5a4494304'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 0, 0, 0, 123.5, 123.5, 0),
  ('e81d982d-ac51-4ba5-879d-332f3d594941'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 66.5, 29.45, 0, 0, 95.95, 2974.05),
  ('407e0160-6901-4804-8440-d7b3ad2937b3'::uuid, '8036f6dd-7531-43eb-9803-ffe01071e909'::uuid, 66.5, 20.24, 0, 0, 86.74, 2023.26),
  ('52fd92c1-4462-45df-9e8f-3e49a51a8806'::uuid, '9514b0b1-a2e4-498d-82c6-5ccf0022364c'::uuid, 0, 0, 0, 115, 115, 0),
  ('fe788801-053d-499f-9ab0-7f05619a649c'::uuid, '9514b0b1-a2e4-498d-82c6-5ccf0022364c'::uuid, 115, 51, 0, 0, 166, 5043),
  ('74d40591-581d-40ba-a368-a9cb3831409a'::uuid, '601eef9a-b832-4d85-b441-9e9667f5002c'::uuid, 108.34, 22.82, 0, 0, 131.16, 2247.84),
  ('9a806684-b842-45b5-b304-f861b7e04399'::uuid, '601eef9a-b832-4d85-b441-9e9667f5002c'::uuid, 108.33, 21.77, 0, 0, 130.1, 2139.9),
  ('eb521153-521a-4f3d-9498-c3e475d9010a'::uuid, '601eef9a-b832-4d85-b441-9e9667f5002c'::uuid, 0, 0, 0, 65, 65, 0),
  ('b80a082c-8f6d-4c57-b97c-e1eeefa1bb6c'::uuid, '601eef9a-b832-4d85-b441-9e9667f5002c'::uuid, 108.33, 39.13, 0, 0, 147.46, 3931.54),
  ('b15f5e04-e7ff-44cf-b4e6-d9c260c5ad1b'::uuid, '601eef9a-b832-4d85-b441-9e9667f5002c'::uuid, 108.33, 0, 0, 0, 108.33, -108.33),
  ('59239de4-70b7-4151-b245-60988b02254e'::uuid, '601eef9a-b832-4d85-b441-9e9667f5002c'::uuid, 0, 33.28, 0, 65, 98.28, 3435.72),
  ('38c2ed4a-cf1c-42b9-8254-4bc9f3d33d8c'::uuid, 'fde63c5c-3803-4bd9-be33-36324ab04fa8'::uuid, 105, 8, 0, 0, 113, 787),
  ('d2165141-dfdb-443e-a75c-57ace11211be'::uuid, 'a3b9a80f-36af-42be-b455-2d3812419998'::uuid, 0, 0, 0, 115, 115, 0),
  ('24d21c84-a9d9-4b95-9de6-aec00842a752'::uuid, 'a3b9a80f-36af-42be-b455-2d3812419998'::uuid, 135, 88, 0, 0, 223, 8707),
  ('2bbc199e-ae11-4a17-b2fc-844f43c186bd'::uuid, '26c7683c-2368-4ee0-84ac-f3545d85e39e'::uuid, 55, 11, 0, 0, 66, 1084),
  ('073aaa0d-e0d1-4db3-83d8-83753d9b8511'::uuid, '0dc19704-810e-45f8-b690-0bc5d811b958'::uuid, 0, 0, 0, 65, 65, 0),
  ('040a3d45-b8a9-4d9c-928a-23d3700c88d5'::uuid, '0dc19704-810e-45f8-b690-0bc5d811b958'::uuid, 110.5, 0, 0, 0, 110.5, -110.5),
  ('4206ee58-7f43-470a-917e-5c96111c33ab'::uuid, '0dc19704-810e-45f8-b690-0bc5d811b958'::uuid, 59.5, 21, 0, 0, 80.5, 2039.5),
  ('96c22504-31e9-459e-8f12-a4402233b935'::uuid, 'b8213137-9013-4127-85c1-62a8c0bf0cb0'::uuid, 110, 14, 0, 0, 124, 1476),
  ('03c947e7-40f8-43bb-93b0-c6a3a2d0b491'::uuid, 'b8213137-9013-4127-85c1-62a8c0bf0cb0'::uuid, 110, 0, 0, 0, 110, -110),
  ('68c36a8f-e1e8-45a2-89c8-0f7bde8d54fb'::uuid, 'a43a817c-bd55-4f6e-8a51-941caf394de1'::uuid, 0, 0, 0, 65, 65, 0),
  ('6f669626-b1f0-453f-a9f0-1d5bda6f0f97'::uuid, 'a43a817c-bd55-4f6e-8a51-941caf394de1'::uuid, 105, 9, 0, 0, 114, 886)
) AS v (order_id, payout_id, dc, fee, oth, sep, kept, net)
WHERE c.order_id = v.order_id AND c.payout_id = v.payout_id;

SELECT set_config('payout.unsettle', '', true);

-- ---------------------------------------------------------------- D
-- The zone's delivery fee from Settings (null when it is not a number).
CREATE OR REPLACE FUNCTION public.courier_zone_fee(p_zone text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN btrim(s.value) ~ '^[0-9]+([.][0-9]+)?$' THEN btrim(s.value)::numeric END
  FROM app_settings s
  WHERE s.key = CASE p_zone WHEN 'inside_dhaka' THEN 'delivery_fee_inside_dhaka'
                            WHEN 'outside_dhaka' THEN 'delivery_fee_outside_dhaka' END;
$$;

REVOKE ALL ON FUNCTION public.courier_zone_fee(text) FROM PUBLIC, anon, authenticated;

-- One answer for "what did the courier cost this order, and how sure are
-- we": used by the order Profit card and by every profit total (Home,
-- Money, Sales profit and the reports all read inventory_sales_profit_core).
--   exact      the payout held only this parcel (Steadfast's own numbers)
--   share      this parcel's share of a payout with several parcels
--   expected   delivered, booked on Steadfast, no payout yet: the average
--              delivery bill of the last 10 delivered orders of the same
--              zone that have a payout share (fewer than 3: the zone's
--              delivery fee in Settings), plus the 1% COD fee on
--              (COD − that bill), both rounded to the taka like Steadfast
--   none       handed over by hand (zone "hand_delivered"): ৳0, final
--   not_booked never booked on Steadfast: ৳0, as before
--   unknown    anything else without a payout (shipped, returned): ৳0
CREATE OR REPLACE FUNCTION public.order_courier_costs_for(p_ids uuid[])
RETURNS TABLE (order_id uuid, amount numeric, kind text, delivery_bill numeric, cod_fee numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH zone_history AS (
    SELECT z.zone, count(*) AS n, avg(z.bill) AS bill
    FROM (
      SELECT o.delivery_zone AS zone, cc.delivery_charge + cc.bill_paid_separately AS bill,
             row_number() OVER (PARTITION BY o.delivery_zone ORDER BY o.created_at DESC, o.order_number DESC) AS rn
      FROM order_courier_costs cc
      JOIN orders o ON o.id = cc.order_id
      WHERE o.status = 'delivered' AND o.delivery_zone IN ('inside_dhaka', 'outside_dhaka')
    ) z
    WHERE z.rn <= 10
    GROUP BY z.zone
  ), parcels AS (
    SELECT i.payout_id, count(*) AS n
    FROM steadfast_payout_items i
    WHERE i.payout_id IN (SELECT c.payout_id FROM order_courier_costs c WHERE c.order_id = ANY (p_ids))
    GROUP BY i.payout_id
  ), expected AS (
    SELECT o.id,
           round(CASE WHEN h.n >= 3 THEN h.bill
                      ELSE COALESCE(courier_zone_fee(o.delivery_zone), o.delivery_fee) END) AS bill,
           COALESCE(o.steadfast_cod_amount, 0) AS cod
    FROM orders o
    LEFT JOIN zone_history h ON h.zone = o.delivery_zone
    WHERE o.id = ANY (p_ids)
  ), kinds AS (
    SELECT o.id,
           CASE
             WHEN cc.order_id IS NOT NULL THEN CASE WHEN p.n = 1 THEN 'exact' ELSE 'share' END
             WHEN o.delivery_zone = 'hand_delivered' THEN 'none'
             WHEN o.steadfast_consignment_id IS NULL THEN 'not_booked'
             WHEN o.status = 'delivered' THEN 'expected'
             ELSE 'unknown'
           END AS kind,
           cc.total_kept, cc.delivery_charge, cc.other_deduction, cc.bill_paid_separately, cc.cod_fee,
           e.bill, round(0.01 * GREATEST(e.cod - e.bill, 0)) AS exp_fee
    FROM orders o
    LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
    LEFT JOIN parcels p ON p.payout_id = cc.payout_id
    LEFT JOIN expected e ON e.id = o.id
    WHERE o.id = ANY (p_ids)
  )
  SELECT k.id,
         CASE k.kind WHEN 'exact' THEN k.total_kept WHEN 'share' THEN k.total_kept
                     WHEN 'expected' THEN COALESCE(k.bill, 0) + COALESCE(k.exp_fee, 0) ELSE 0 END,
         k.kind,
         CASE WHEN k.kind IN ('exact', 'share') THEN k.delivery_charge + k.other_deduction + k.bill_paid_separately
              WHEN k.kind = 'expected' THEN COALESCE(k.bill, 0) ELSE 0 END,
         CASE WHEN k.kind IN ('exact', 'share') THEN k.cod_fee
              WHEN k.kind = 'expected' THEN COALESCE(k.exp_fee, 0) ELSE 0 END
  FROM kinds k;
$$;

REVOKE ALL ON FUNCTION public.order_courier_costs_for(uuid[]) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------- F
CREATE OR REPLACE FUNCTION public.order_profit(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order    orders%ROWTYPE;
  v_courier  order_courier_costs%ROWTYPE;
  v_known    boolean;
  v_sale     numeric;
  v_cost     numeric;
  v_prov     numeric;
  v_costed   boolean;
  v_delivery numeric;
  v_kept     numeric;
  v_profit   numeric;
  v_filled   numeric;
  v_cc       record;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  SELECT * INTO v_courier FROM order_courier_costs WHERE order_id = p_order_id;
  v_known := FOUND;
  -- Batch 53: the courier cost and how sure it is (order_courier_costs_for).
  SELECT * INTO v_cc FROM order_courier_costs_for(ARRAY[p_order_id]);

  SELECT COALESCE(sum(c.cost), 0), COALESCE(sum(c.provisional), 0), COALESCE(bool_and(c.costed), false)
  INTO v_cost, v_prov, v_costed
  FROM inventory_item_costs(ARRAY[p_order_id]) c;

  SELECT COALESCE(sum(amount_bdt), 0) INTO v_filled
  FROM cost_adjustments WHERE order_id = p_order_id AND reason IN ('shortfall_filled', 'given_back');

  IF v_order.status = 'cancelled' THEN
    v_sale := 0; v_cost := 0; v_prov := 0; v_delivery := 0; v_kept := 0;
  ELSIF v_order.status = 'returned' THEN
    v_sale := 0; v_cost := 0; v_prov := 0; v_delivery := 0;
    v_kept := CASE WHEN v_known THEN v_courier.total_kept ELSE 0 END;
  ELSE
    v_sale := GREATEST(v_order.subtotal - v_order.discount, 0);
    v_delivery := v_order.delivery_fee;
    v_kept := COALESCE(v_cc.amount, 0);
  END IF;
  v_profit := v_sale - v_cost + v_delivery - v_kept;

  RETURN jsonb_build_object(
    'status', v_order.status,
    'costed', v_costed OR v_order.status IN ('cancelled', 'returned'),
    'sale', v_sale,
    'cost', v_cost,
    'provisional', v_prov,
    'delivery', v_delivery,
    'courier', v_kept,
    'courier_known', v_known OR v_cc.kind = 'none',
    'courier_kind', CASE WHEN v_order.status IN ('cancelled', 'returned') AND NOT v_known
                         THEN CASE WHEN v_cc.kind IN ('none', 'not_booked') THEN v_cc.kind ELSE 'unknown' END
                         ELSE v_cc.kind END,
    'courier_charge', CASE WHEN v_order.status = 'cancelled' THEN 0 ELSE COALESCE(v_cc.delivery_bill, 0) END,
    'cod_fee', CASE WHEN v_order.status = 'cancelled' THEN 0 ELSE COALESCE(v_cc.cod_fee, 0) END,
    'bill_paid_separately', CASE WHEN v_known THEN v_courier.bill_paid_separately ELSE 0 END,
    'profit', v_profit,
    'margin', CASE WHEN v_sale > 0 THEN round(v_profit / v_sale * 100, 1) END,
    'counted_at', inventory_order_counted_at(p_order_id, v_order.status),
    'filled_adjustments', v_filled
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.inventory_sales_profit_core(p_from date, p_to date, p_for_money boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids      uuid[];
  v_orders   jsonb;
  v_products jsonb;
  v_adjust   jsonb;
  v_totals   jsonb;
  v_adj_sum  numeric;
  v_ret      numeric;
  v_ret_n    integer;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Pick a date range.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _sp_orders (
    id uuid, order_number text, status text, counted_at timestamptz, sale numeric, discount numeric,
    delivery numeric, courier numeric, courier_known boolean, cost numeric, provisional numeric, costed boolean,
    courier_kind text
  ) ON COMMIT DROP;
  -- Batch 53: the same transaction may still hold the table from the old
  -- version of this function (without courier_kind).
  ALTER TABLE _sp_orders ADD COLUMN IF NOT EXISTS courier_kind text;
  TRUNCATE _sp_orders;

  INSERT INTO _sp_orders (id, order_number, status, counted_at, sale, discount, delivery, courier, courier_known)
  SELECT o.id, o.order_number, o.status, x.at,
         CASE WHEN o.status = 'delivered' THEN GREATEST(o.subtotal - o.discount, 0) ELSE 0 END,
         o.discount,
         CASE WHEN o.status = 'delivered' THEN o.delivery_fee ELSE 0 END,
         COALESCE(cc.total_kept, 0), cc.order_id IS NOT NULL
  FROM orders o
  LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
  -- Batch 46: a cancelled order whose parcel Steadfast charged for counts
  -- that charge (no sale), on the payout's date.
  CROSS JOIN LATERAL (SELECT COALESCE(inventory_order_counted_at(o.id, o.status),
                                     CASE WHEN o.status = 'cancelled' THEN cc.paid_at END) AS at) x
  WHERE (o.status IN ('delivered', 'returned') OR (o.status = 'cancelled' AND cc.order_id IS NOT NULL))
    AND (x.at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN p_from AND p_to;

  SELECT COALESCE(array_agg(id), '{}') INTO v_ids FROM _sp_orders;

  -- Batch 53: a delivered order booked on Steadfast with no payout yet
  -- counts its EXPECTED courier cost (not ৳0); every order gets a label.
  UPDATE _sp_orders so
  SET courier = CASE WHEN so.status = 'delivered' THEN c.amount ELSE so.courier END,
      courier_known = so.courier_known OR c.kind = 'none',
      courier_kind = CASE WHEN so.status = 'delivered' OR so.courier_known OR c.kind IN ('none', 'not_booked')
                          THEN c.kind ELSE 'unknown' END
  FROM order_courier_costs_for(v_ids) c
  WHERE c.order_id = so.id;

  CREATE TEMP TABLE IF NOT EXISTS _sp_items (
    order_item_id uuid, order_id uuid, product_id uuid, variant_id uuid, label text, line_total numeric,
    units integer, cost numeric, provisional numeric, costed boolean
  ) ON COMMIT DROP;
  TRUNCATE _sp_items;
  INSERT INTO _sp_items SELECT * FROM inventory_item_costs(v_ids);

  UPDATE _sp_orders o
  SET cost = CASE WHEN o.status = 'delivered' THEN COALESCE(i.cost, 0) ELSE 0 END,
      provisional = CASE WHEN o.status = 'delivered' THEN COALESCE(i.provisional, 0) ELSE 0 END,
      costed = COALESCE(i.costed, false)
  FROM (
    SELECT order_id, sum(cost) AS cost, sum(provisional) AS provisional, bool_and(costed) AS costed
    FROM _sp_items GROUP BY order_id
  ) i
  WHERE i.order_id = o.id;
  -- (Orders with no lines at all. A WHERE is required: the API refuses an
  -- UPDATE without one.)
  UPDATE _sp_orders SET cost = COALESCE(cost, 0), provisional = COALESCE(provisional, 0), costed = COALESCE(costed, false)
  WHERE cost IS NULL OR provisional IS NULL OR costed IS NULL;
  -- Batch 45: for the Money page, an order placed before the money start
  -- and not taken from lots was already owed in the opening balance; its
  -- sale is not counted a second time as profit.
  IF p_for_money AND money_start_date() IS NOT NULL THEN
    UPDATE _sp_orders so SET costed = false
    FROM orders o
    WHERE o.id = so.id AND so.costed AND o.created_at < money_start_ts()
      AND so.counted_at >= money_start_ts() AND NOT money_order_costed(o.id);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_id', id, 'order_number', order_number, 'status', status, 'counted_at', counted_at,
           'sale', sale, 'cost', cost, 'provisional', provisional, 'delivery', delivery,
           'courier', courier, 'courier_known', courier_known, 'courier_kind', courier_kind, 'costed', costed,
           'profit', sale - cost + delivery - courier,
           'margin', CASE WHEN sale > 0 THEN round((sale - cost + delivery - courier) / sale * 100, 1) END)
         ORDER BY counted_at DESC, order_number DESC), '[]'::jsonb)
  INTO v_orders FROM _sp_orders;

  -- Per product: delivered, costed orders only.
  WITH lines AS (
    SELECT i.*, o.discount AS order_discount, o.id AS oid
    FROM _sp_items i JOIN _sp_orders o ON o.id = i.order_id
    WHERE o.status = 'delivered' AND o.costed
  ), paisa AS (
    SELECT l.*, round(l.line_total * 100) AS lp, round(l.order_discount * 100) AS dp,
           sum(round(l.line_total * 100)) OVER (PARTITION BY l.oid) AS tp
    FROM lines l
  ), floors AS (
    SELECT p.*,
           CASE WHEN p.tp > 0 THEN div(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_floor,
           CASE WHEN p.tp > 0 THEN mod(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_rem
    FROM paisa p
  ), ranked AS (
    SELECT f.*,
           row_number() OVER (PARTITION BY f.oid ORDER BY f.d_rem DESC, f.order_item_id) AS d_rank,
           LEAST(f.dp, f.tp) - sum(f.d_floor) OVER (PARTITION BY f.oid) AS d_left
    FROM floors f
  ), shared AS (
    SELECT r.product_id, r.variant_id, r.label, r.units, r.cost,
           (r.lp - r.d_floor - CASE WHEN r.d_rank <= r.d_left THEN 1 ELSE 0 END) / 100.0 AS sale
    FROM ranked r
  ), per_product AS (
    SELECT s.product_id, s.variant_id, min(s.label) AS label, sum(s.units)::bigint AS units,
           round(sum(s.sale), 2) AS sales, round(sum(s.cost), 2) AS cost
    FROM shared s
    GROUP BY s.product_id, s.variant_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', product_id, 'variant_id', variant_id, 'label', label, 'units', units,
           'stock_unit', inventory_stock_unit(product_id, variant_id),
           'pack_size', inventory_pack_size(product_id, variant_id),
           'sales', sales, 'cost', cost, 'profit', sales - cost,
           'margin', CASE WHEN sales > 0 THEN round((sales - cost) / sales * 100, 1) END)
         ORDER BY sales - cost DESC, label), '[]'::jsonb)
  INTO v_products FROM per_product;

  SELECT COALESCE(sum(amount_bdt), 0),
         COALESCE(jsonb_agg(jsonb_build_object('date', adj_date, 'amount', amount_bdt, 'reason', reason, 'note', note)
                            ORDER BY adj_date, created_at), '[]'::jsonb)
  INTO v_adj_sum, v_adjust
  FROM cost_adjustments WHERE adj_date BETWEEN p_from AND p_to
    -- Batch 45: a sale's cost is stored on the sale; these old corrections
    -- are already inside it.
    AND reason NOT IN ('late_bill', 'shortfall_filled', 'given_back');

  SELECT jsonb_build_object(
           'orders', count(*) FILTER (WHERE costed),
           'uncosted_orders', count(*) FILTER (WHERE NOT costed),
           'items_missing_cost', (SELECT count(*) FROM _sp_items i JOIN _sp_orders so ON so.id = i.order_id
                                  WHERE so.status = 'delivered' AND NOT i.costed),
           'sales', COALESCE(sum(sale) FILTER (WHERE costed), 0),
           'cost', COALESCE(sum(cost) FILTER (WHERE costed), 0),
           'provisional', COALESCE(sum(provisional) FILTER (WHERE costed), 0),
           'delivery', COALESCE(sum(delivery) FILTER (WHERE costed), 0),
           'courier', COALESCE(sum(courier) FILTER (WHERE costed), 0),
           'adjustments', v_adj_sum)
  INTO v_totals FROM _sp_orders;

  -- Batch 46: a returned parcel whose order was deleted (its payout line is
  -- marked "returned"): no sale; Steadfast's charge is a courier cost on
  -- the payout's date, with the other returned parcels' charges.
  SELECT COALESCE(sum(i.delivery_charge + i.cod_fee + i.other_deduction + i.bill_paid_separately), 0), count(*)
  INTO v_ret, v_ret_n
  FROM steadfast_payout_items i JOIN steadfast_payouts sp ON sp.id = i.payout_id
  WHERE i.line_kind = 'returned' AND i.order_id IS NULL
    AND (sp.paid_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN p_from AND p_to
    AND (NOT p_for_money OR money_start_date() IS NULL OR sp.paid_at >= money_start_ts());
  v_totals := v_totals || jsonb_build_object(
    'courier', (v_totals ->> 'courier')::numeric + v_ret,
    'courier_no_order', v_ret, 'returned_no_order', v_ret_n);

  v_totals := v_totals || jsonb_build_object(
    'profit', (v_totals ->> 'sales')::numeric - (v_totals ->> 'cost')::numeric + (v_totals ->> 'delivery')::numeric
              - (v_totals ->> 'courier')::numeric - v_adj_sum);
  v_totals := v_totals || jsonb_build_object(
    'margin', CASE WHEN (v_totals ->> 'sales')::numeric > 0
                   THEN round((v_totals ->> 'profit')::numeric / (v_totals ->> 'sales')::numeric * 100, 1) END);

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'totals', v_totals,
                            'orders', v_orders, 'products', v_products, 'adjustments', v_adjust);
END;
$function$;

COMMIT;

-- Check (optional): every payout still adds up to Steadfast's total.
-- SELECT p.steadfast_payment_id, p.total_amount, sum(i.net_paid) AS lines
-- FROM steadfast_payouts p JOIN steadfast_payout_items i ON i.payout_id = p.id
-- GROUP BY p.id HAVING p.total_amount <> sum(i.net_paid);   -- no rows = right
