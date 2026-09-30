import { CHECKOUT_LOGIN_COPY } from './checkoutCopy';
import type { AppSettings } from '../types';

/** An app_settings key that holds an editable site text. */
export type EditableTextKey = 'text_checkout_signin_title' | 'text_checkout_signin_message';

export interface EditableTextField {
  key: EditableTextKey;
  label: string;
  /** Shown whenever the saved text is empty. */
  defaultText: string;
  multiline: boolean;
}

export interface EditableTextGroup {
  id: string;
  title: string;
  description: string;
  fields: EditableTextField[];
}

/**
 * Site texts Naeem can change in Admin → Settings → Texts (Batch 24 Part 7).
 * To make another text editable: add its key to AppSettings and
 * TEXT_SETTING_KEYS (ProductContext), add a group or field here, and read it
 * with siteText() where it is shown. Nothing else is needed.
 */
export const EDITABLE_TEXT_GROUPS: EditableTextGroup[] = [
  {
    id: 'checkout-signin',
    title: 'Checkout sign-in note',
    description: 'Shown when a shopper who is not signed in taps Checkout.',
    fields: [
      {
        key: 'text_checkout_signin_title',
        label: 'Title',
        defaultText: CHECKOUT_LOGIN_COPY.title,
        multiline: false,
      },
      {
        key: 'text_checkout_signin_message',
        label: 'Message',
        defaultText: CHECKOUT_LOGIN_COPY.message,
        multiline: true,
      },
    ],
  },
];

const DEFAULTS: Record<EditableTextKey, string> = Object.fromEntries(
  EDITABLE_TEXT_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.defaultText]))
) as Record<EditableTextKey, string>;

/** The text to show: the saved one, or the default when it is empty — so
 *  the page never shows a blank or broken text. */
export function siteText(settings: Pick<AppSettings, EditableTextKey>, key: EditableTextKey): string {
  const saved = settings[key];
  return typeof saved === 'string' && saved.trim() !== '' ? saved.trim() : DEFAULTS[key];
}
