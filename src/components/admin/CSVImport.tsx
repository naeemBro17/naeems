import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import Papa from 'papaparse';
import { supabase } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { slugify } from '../../lib/format';
import {
  generateTemplate,
  productsToCSV,
  downloadCSV,
  exportFilename,
  normalizeStockStatus,
  parseBooleanFlag,
} from '../../lib/csvUtils';
import { Modal } from '../shared/Modal';
import type { CSVRow, CSVRowValidation, ImportSummary } from '../../types';

const PREVIEW_VISIBLE_ROWS = 10;

function toCSVRow(raw: Record<string, string>): CSVRow {
  const field = (key: string) => (raw[key] ?? '').trim();
  return {
    sku: field('sku'),
    name: field('name'),
    description: field('description'),
    category_name: field('category_name'),
    retail_price: field('retail_price'),
    offer_price: field('offer_price'),
    wholesale_price: field('wholesale_price'),
    stock_status: field('stock_status'),
    stock_quantity: field('stock_quantity'),
    note: field('note'),
    is_active: field('is_active'),
  };
}

function validateRow(row: CSVRow): string[] {
  const errors: string[] = [];
  if (row.sku === '') errors.push('Missing sku');
  if (row.name === '') errors.push('Missing name');
  if (row.retail_price === '') {
    errors.push('Missing retail_price');
  } else {
    const price = Number(row.retail_price);
    if (Number.isNaN(price) || price < 0) errors.push('Invalid retail_price');
  }
  if (row.offer_price !== '') {
    const offer = Number(row.offer_price);
    if (Number.isNaN(offer) || offer < 0) {
      errors.push('Invalid offer_price');
    } else if (row.retail_price !== '') {
      const retail = Number(row.retail_price);
      if (!Number.isNaN(retail) && offer >= retail) {
        errors.push('offer_price must be lower than retail_price');
      }
    }
  }
  if (row.wholesale_price !== '') {
    const price = Number(row.wholesale_price);
    if (Number.isNaN(price) || price < 0) errors.push('Invalid wholesale_price');
  }
  if (normalizeStockStatus(row.stock_status) === null) {
    errors.push('Invalid stock_status (use in_stock, low_stock or out_of_stock)');
  }
  if (row.stock_quantity !== '') {
    const qty = Number(row.stock_quantity);
    if (!Number.isInteger(qty) || qty < 0) errors.push('Invalid stock_quantity');
  }
  if (parseBooleanFlag(row.is_active) === null) {
    errors.push('Invalid is_active (use true/false, 1/0 or yes/no)');
  }
  if (row.note.length > 200) errors.push('Note exceeds 200 characters');
  return errors;
}

export function CSVImport() {
  const { products, categories, refetch } = useProducts();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<CSVRowValidation[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const validRows = rows.filter((r) => r.errors.length === 0);
  const invalidRows = rows.filter((r) => r.errors.length > 0);

  const handleFile = (file: File) => {
    setParseError(null);
    setRows([]);
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Could not parse CSV. Please use the provided template.');
      return;
    }
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        const requiredHeaders = ['sku', 'name', 'retail_price'];
        if (!requiredHeaders.every((h) => headers.includes(h))) {
          setParseError('Could not parse CSV. Please use the provided template.');
          return;
        }
        const parsed = results.data.map((raw, index): CSVRowValidation => {
          const row = toCSVRow(raw);
          return { row, rowNumber: index + 2, errors: validateRow(row) };
        });
        if (parsed.length === 0) {
          setParseError('Could not parse CSV. Please use the provided template.');
          return;
        }
        setRows(parsed);
      },
      error: () => {
        setParseError('Could not parse CSV. Please use the provided template.');
      },
    });
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };

  const handleImport = async () => {
    setIsImporting(true);

    const existingSkus = new Set(products.map((p) => p.sku));
    const categoryIdByName = new Map<string, string>(
      categories.map((c) => [c.name.toLowerCase(), c.id])
    );

    const result: ImportSummary = { added: 0, updated: 0, failed: [] };

    for (const invalid of invalidRows) {
      result.failed.push({
        rowNumber: invalid.rowNumber,
        sku: invalid.row.sku || '—',
        reason: invalid.errors.join('; '),
      });
    }

    for (const { row, rowNumber } of validRows) {
      // Resolve the category: look up by name, create it if not found.
      let categoryId: string | null = null;
      if (row.category_name !== '') {
        const key = row.category_name.toLowerCase();
        const cached = categoryIdByName.get(key);
        if (cached) {
          categoryId = cached;
        } else {
          const { data, error } = await supabase
            .from('categories')
            .insert({ name: row.category_name, slug: slugify(row.category_name) })
            .select()
            .single();
          if (error || !data) {
            result.failed.push({
              rowNumber,
              sku: row.sku,
              reason: `Could not create category '${row.category_name}'`,
            });
            continue;
          }
          categoryId = data.id as string;
          categoryIdByName.set(key, categoryId);
        }
      }

      const payload = {
        sku: row.sku,
        name: row.name,
        description: row.description === '' ? null : row.description,
        category_id: categoryId,
        retail_price: Number(row.retail_price),
        offer_price: row.offer_price === '' ? null : Number(row.offer_price),
        wholesale_price: row.wholesale_price === '' ? null : Number(row.wholesale_price),
        stock_status: normalizeStockStatus(row.stock_status) ?? 'in_stock',
        stock_quantity: row.stock_quantity === '' ? null : Number(row.stock_quantity),
        note: row.note === '' ? null : row.note,
        is_active: parseBooleanFlag(row.is_active) ?? true,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('products')
        .upsert(payload, { onConflict: 'sku' });

      if (error) {
        result.failed.push({ rowNumber, sku: row.sku, reason: error.message });
      } else if (existingSkus.has(row.sku)) {
        result.updated += 1;
      } else {
        result.added += 1;
        existingSkus.add(row.sku);
      }
    }

    await refetch();
    setIsImporting(false);
    setRows([]);
    setSummary(result);
  };

  const handleExport = () => {
    downloadCSV(exportFilename(), productsToCSV(products));
    showToast('Export downloaded');
  };

  return (
    <section aria-label="Import and export">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Import / Export</h2>
      </header>

      <div className="admin-panel">
        <h3 className="admin-panel__title">CSV Import</h3>

        <button
          type="button"
          className="button button--secondary"
          onClick={() => downloadCSV('naeem-price-hub-template.csv', generateTemplate())}
        >
          Download CSV Template
        </button>

        <div
          className={`csv-dropzone${isDragging ? ' csv-dropzone--active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Upload CSV file"
        >
          <p className="csv-dropzone__hint">
            Drag &amp; drop a .csv file here, or tap to choose
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleInputChange}
          className="visually-hidden"
          aria-label="Choose CSV file"
        />

        {parseError && (
          <div className="error-banner" role="alert">
            {parseError}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <p className="csv-ready-count">
              {validRows.length} {validRows.length === 1 ? 'row' : 'rows'} ready to import
              {invalidRows.length > 0 &&
                ` — ${invalidRows.length} with errors (highlighted below)`}
            </p>
            <div
              className="csv-preview-wrap"
              style={{
                maxHeight: `${PREVIEW_VISIBLE_ROWS * 44 + 48}px`,
              }}
            >
              <table className="csv-preview-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Name</th>
                    <th scope="col">Category</th>
                    <th scope="col">Retail ৳</th>
                    <th scope="col">Status</th>
                    <th scope="col">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ row, rowNumber, errors }) => (
                    <tr
                      key={rowNumber}
                      className={errors.length > 0 ? 'csv-preview-row--error' : ''}
                    >
                      <td>{rowNumber}</td>
                      <td>{row.sku || '—'}</td>
                      <td>{row.name || '—'}</td>
                      <td>{row.category_name || '—'}</td>
                      <td>{row.retail_price || '—'}</td>
                      <td>{row.stock_status || 'in_stock'}</td>
                      <td>{errors.length > 0 ? errors.join('; ') : '✓'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="button button--primary"
              onClick={handleImport}
              disabled={isImporting || validRows.length === 0}
            >
              {isImporting ? <span className="spinner" aria-hidden="true" /> : 'Confirm Import'}
            </button>
          </>
        )}
      </div>

      <div className="admin-panel">
        <h3 className="admin-panel__title">CSV Export</h3>
        <p className="admin-panel__description">
          Downloads all products (active and inactive) as a CSV file.
        </p>
        <button type="button" className="button button--primary" onClick={handleExport}>
          Export All Products
        </button>
      </div>

      <Modal
        isOpen={summary !== null}
        onClose={() => setSummary(null)}
        title="Import Summary"
      >
        {summary && (
          <div className="import-summary">
            <p className="import-summary__line import-summary__line--success">
              ✓ {summary.added} added
            </p>
            <p className="import-summary__line import-summary__line--success">
              ✓ {summary.updated} updated
            </p>
            <p className="import-summary__line import-summary__line--failed">
              ✗ {summary.failed.length} failed
            </p>
            {summary.failed.length > 0 && (
              <div className="csv-preview-wrap">
                <table className="csv-preview-table">
                  <thead>
                    <tr>
                      <th scope="col">Row #</th>
                      <th scope="col">SKU</th>
                      <th scope="col">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.failed.map((failure) => (
                      <tr key={`${failure.rowNumber}-${failure.sku}`}>
                        <td>{failure.rowNumber}</td>
                        <td>{failure.sku}</td>
                        <td>{failure.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <button
              type="button"
              className="button button--primary button--full"
              onClick={() => setSummary(null)}
            >
              Done
            </button>
          </div>
        )}
      </Modal>
    </section>
  );
}
