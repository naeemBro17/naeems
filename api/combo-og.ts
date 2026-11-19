// Vercel serverless function — Batch 52 Part 1.3 (combo link previews).
//
// Same idea as product-og.ts: vercel.json sends ONLY link-preview robots'
// requests for /c/:code here (a `has` user-agent condition). Real visitors
// get the normal app. The picture is the combo's collage, drawn once in
// the admin's browser when the combo was made and saved as one file — so
// a preview request never downloads product photos.

import { SITE_URL, comboPreview, isComboCode, renderPreviewHtml, shopPreview } from './_og.js';

interface MinimalRequest {
  query: Record<string, string | string[] | undefined>;
}

interface MinimalResponse {
  setHeader(name: string, value: string): void;
  status(code: number): MinimalResponse;
  send(body: string): void;
}

interface ComboRow {
  name: string;
  preview_url: string | null;
  items: unknown[];
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  const codeParam = req.query.code;
  const code = Array.isArray(codeParam) ? codeParam[0] : codeParam;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');

  const url = code ? `${SITE_URL}/c/${code}` : `${SITE_URL}/`;
  const fallback = () => {
    res.status(200).send(renderPreviewHtml(shopPreview(url)));
  };

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!code || !isComboCode(code) || !supabaseUrl || !supabaseAnonKey) {
    fallback();
    return;
  }

  try {
    const apiRes = await fetch(`${supabaseUrl}/rest/v1/rpc/get_combo`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_code: code }),
    });
    if (!apiRes.ok) {
      fallback();
      return;
    }
    const combo = (await apiRes.json()) as ComboRow | null;
    if (!combo || typeof combo.name !== 'string') {
      fallback();
      return;
    }
    const count = Array.isArray(combo.items) ? combo.items.length : 0;
    res.status(200).send(renderPreviewHtml(comboPreview(combo.name, count, combo.preview_url, url)));
  } catch {
    fallback();
  }
}
