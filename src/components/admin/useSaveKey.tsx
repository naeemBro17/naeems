import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { saveSettings } from '../../lib/settingsLists';
import type { AppSettings } from '../../types';

/** The app_settings keys the Banner & Texts panels save one at a time
 *  (Batch 71's Home keys, Batch 72's routine keys). */
export type PanelSettingKey =
  | 'home_tips'
  | 'home_show_skin_types'
  | 'home_show_concerns'
  | 'home_show_combos'
  | 'home_concerns'
  | 'home_combo_codes'
  | 'home_videos'
  | 'routine_rules'
  | 'routine_fallback'
  | 'routine_questions';

/** Saves one app_settings row, reloads the shop's settings, says so. */
export function useSaveKey() {
  const { refetch } = useProducts();
  const { showToast } = useToast();
  return async (key: PanelSettingKey, value: string): Promise<boolean> => {
    const values: Partial<Record<keyof AppSettings, string>> = { [key]: value };
    const error = await saveSettings(values);
    if (error) {
      console.error(`Saving ${key} failed:`, error);
      showToast('Could not save. Please try again.', 'error');
      return false;
    }
    await refetch();
    showToast('Saved');
    return true;
  };
}

export function SaveRow({ busy, dirty, onSave }: { busy: boolean; dirty: boolean; onSave: () => void }) {
  return (
    <div className="b71a-save">
      <button type="button" className="button button--primary" onClick={onSave} disabled={busy || !dirty}>
        {busy ? <span className="spinner" aria-hidden="true" /> : 'Save'}
      </button>
    </div>
  );
}
