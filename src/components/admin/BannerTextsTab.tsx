import { BannerSlidesPanel, ExpertSettingsPanel } from './SettingsTab';
import { TextsPanel } from './SettingsExtraPanels';
import { SubPages, type SubPage } from './ui/SubPages';

/**
 * Admin → Store design → Banner & Texts (Batch 25 Part 1). The home banner,
 * the "Talk to an Expert" page and the editable site texts moved here from
 * Settings — the very same panels and fields, only a new place.
 */
export function BannerTextsTab() {
  const pages: SubPage[] = [
    { id: 'banner', group: 'HOME PAGE', label: 'Banner slides', icon: 'bento', render: () => <BannerSlidesPanel /> },
    { id: 'expert', group: 'HOME PAGE', label: 'Expert page (Talk to an Expert)', icon: 'profile', render: () => <ExpertSettingsPanel /> },
    { id: 'texts', group: 'TEXTS', label: 'Site texts (checkout sign-in note)', icon: 'design', render: () => <TextsPanel /> },
  ];
  return (
    <section aria-label="Banner and texts">
      <SubPages title="Banner & Texts" param="dset" pages={pages} />
    </section>
  );
}
