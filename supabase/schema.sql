-- ============================================================
-- Naeem's Price Hub — Database Schema (V1)
-- Run this first in the Supabase SQL Editor.
-- ============================================================

-- Categories: flat list of product categories (e.g. Face Care, Body Care).
CREATE TABLE categories (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  slug       text        NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

-- Products: the core table. One row per SKU.
CREATE TABLE products (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text          UNIQUE NOT NULL,
  name            text          NOT NULL,
  category_id     uuid          REFERENCES categories(id) ON DELETE SET NULL,
  retail_price    numeric(10,2) NOT NULL CHECK (retail_price >= 0),
  wholesale_price numeric(10,2) CHECK (wholesale_price >= 0),
  stock_status    text          NOT NULL DEFAULT 'in_stock'
                                CHECK (stock_status IN ('in_stock','low_stock','out_of_stock')),
  stock_quantity  integer       CHECK (stock_quantity >= 0),
  note            text          CHECK (char_length(note) <= 200),
  image_url       text,
  is_active       boolean       NOT NULL DEFAULT true,
  created_at      timestamptz   DEFAULT now(),
  updated_at      timestamptz   DEFAULT now()
);

-- Indexes for the three ways products are filtered.
CREATE INDEX idx_products_active   ON products(is_active);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_sku      ON products(sku);

-- No GIN index: client-side search across 150 SKUs is instant.
-- No updated_at trigger: set updated_at = now() in every UPDATE query directly.
