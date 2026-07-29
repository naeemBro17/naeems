-- ============================================================
-- Naeem's Price Hub — Seed data (V1)
-- Optional. Run after schema.sql + rls.sql for realistic demo data.
-- 4 categories, 12 products. Prices in BDT.
-- ============================================================

INSERT INTO categories (name, slug) VALUES
  ('Face Care', 'face-care'),
  ('Body Care', 'body-care'),
  ('Hair Care', 'hair-care'),
  ('Sun Care',  'sun-care');

INSERT INTO products
  (sku, name, category_id, retail_price, wholesale_price, stock_status, stock_quantity, note, is_active)
VALUES
  ('FC-001', 'CeraVe Foaming Facial Cleanser 236ml',
    (SELECT id FROM categories WHERE slug = 'face-care'),
    1450.00, 1200.00, 'in_stock', 24, 'Best seller — restock every 2 weeks', true),

  ('FC-002', 'The Ordinary Niacinamide 10% + Zinc 1% 30ml',
    (SELECT id FROM categories WHERE slug = 'face-care'),
    1150.00, 950.00, 'low_stock', 5, 'Original UK stock only', true),

  ('FC-003', 'Simple Kind to Skin Refreshing Facial Wash 150ml',
    (SELECT id FROM categories WHERE slug = 'face-care'),
    550.00, 460.00, 'in_stock', NULL, NULL, true),

  ('FC-004', 'Garnier Micellar Cleansing Water Pink 400ml',
    (SELECT id FROM categories WHERE slug = 'face-care'),
    850.00, 700.00, 'out_of_stock', NULL, 'New shipment expected end of month', true),

  ('FC-005', 'Neutrogena Hydro Boost Water Gel 50g',
    (SELECT id FROM categories WHERE slug = 'face-care'),
    1950.00, 1600.00, 'in_stock', 12, NULL, true),

  ('BC-001', 'Nivea Soft Moisturising Cream 200ml',
    (SELECT id FROM categories WHERE slug = 'body-care'),
    620.00, 520.00, 'in_stock', 40, NULL, true),

  ('BC-002', 'Vaseline Healthy Bright Complete 10 Lotion 400ml',
    (SELECT id FROM categories WHERE slug = 'body-care'),
    750.00, 630.00, 'in_stock', NULL, 'Winter best seller', true),

  ('BC-003', 'Dove Deeply Nourishing Body Wash 500ml',
    (SELECT id FROM categories WHERE slug = 'body-care'),
    980.00, 820.00, 'low_stock', 3, NULL, true),

  ('HC-001', 'Tresemme Keratin Smooth Shampoo 580ml',
    (SELECT id FROM categories WHERE slug = 'hair-care'),
    890.00, 740.00, 'in_stock', 18, NULL, true),

  ('HC-002', 'L''Oreal Paris Extraordinary Oil Serum 100ml',
    (SELECT id FROM categories WHERE slug = 'hair-care'),
    1250.00, 1050.00, 'low_stock', NULL, 'Only gold variant left', true),

  ('SC-001', 'Biore UV Aqua Rich Watery Essence SPF50+ 50g',
    (SELECT id FROM categories WHERE slug = 'sun-care'),
    1350.00, 1120.00, 'in_stock', 30, 'Most requested sunscreen', true),

  ('SC-002', 'Missha All Around Safe Block Essence Sun SPF45 50ml',
    (SELECT id FROM categories WHERE slug = 'sun-care'),
    1100.00, 900.00, 'out_of_stock', NULL, NULL, true);
